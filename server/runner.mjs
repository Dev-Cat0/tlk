import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { TlkSession } from './tlk.mjs';
import { PadletSession, PadletBrowser } from './padlet.mjs';
import { validateConfig } from './config.mjs';

export class Runner {
  constructor({ makeSession = () => new TlkSession(), makePadletSession = options => new PadletSession(options), sleep = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now, maxDuration = 6 * 3600_000 } = {}) {
    this.makeSession = makeSession;
    this.makePadletSession = makePadletSession;
    this.sleep = sleep;
    this.now = now;
    this.maxDuration = maxDuration;
    this.job = null;
    this.pending = null;
  }
  snapshot() { return this.job ? structuredClone(this.job) : null; }
  log(level, text) {
    this.job.logs.push({ id: ++this.logId, at: new Date().toISOString(), level, text });
    if (this.job.logs.length > 200) this.job.logs.shift();
  }
  start(input) {
    if (this.pending) throw Object.assign(new Error('이미 실행 중입니다. 먼저 중지하세요.'), { status: 409 });
    const config = validateConfig(input);
    this.controller = new AbortController();
    this.logId = 0;
    this.job = { id: randomUUID(), status: 'starting', config, sent: 0, startedAt: new Date().toISOString(), endedAt: null, nextAt: null, bots: [], logs: [] };
    this.log('info', config.platform === 'padlet' ? `패들렛 · ${config.boardId} ${config.checkOnly ? '연결을 검사합니다. 게시물은 전송하지 않습니다.' : '게시를 준비합니다.'}` : `#${config.channel} 연결을 시작합니다.`);
    this.pending = Promise.resolve().then(() => this.run(this.controller.signal)).finally(() => { this.pending = null; });
    return this.snapshot();
  }
  async stop() {
    if (!this.pending) return this.snapshot();
    this.job.status = 'stopping';
    this.log('info', '중지를 요청했습니다. 이미 전달된 요청은 취소되지 않을 수 있습니다.');
    this.controller.abort();
    await this.pending;
    return this.snapshot();
  }
  async run(signal) {
    const sessions = [];
    const { config } = this.job;
    const browser = config.platform === 'padlet' ? new PadletBrowser() : null;
    const deadline = setTimeout(() => { this.log('info', '최대 실행 시간(6시간)에 도달했습니다.'); this.controller.abort(); }, this.maxDuration);
    deadline.unref?.();
    try {
      if (config.platform === 'padlet') this.log('info', '메모리 절약을 위해 익명 세션별 브라우저 화면을 하나씩 사용합니다. 실제 게시 간격은 로딩·처리 시간보다 짧아질 수 없습니다.');
      for (let i = 0; i < config.botCount; i++) {
        signal.throwIfAborted();
        const name = `${config.platform === 'padlet' ? '익명 봇' : config.prefix}-${String(i + 1).padStart(2, '0')}`;
        const session = config.platform === 'padlet' ? this.makePadletSession({ subject: config.subject, browser, onProgress: step => this.log('info', `${name} · ${step}`) }) : this.makeSession();
        sessions.push(session);
        if (config.platform === 'padlet') this.log('info', `${name} · 보드 로딩 중 (최대 90초 대기)`);
        try { await session.join(config.platform === 'padlet' ? config.boardUrl : config.channel, name, signal); }
        catch (error) { throw new Error(`${name} · ${error.message}`, { cause: error }); }
        signal.throwIfAborted();
        this.job.bots.push({ name, sent: 0 });
        this.log('info', `${name} ${config.platform === 'padlet' ? '전송 준비 완료' : '참가 완료'}`);
      }
      if (config.checkOnly) {
        this.job.status = 'completed';
        this.log('success', `익명 봇 ${sessions.length}개 연결 검사 완료. 게시물은 전송하지 않았습니다.`);
        return;
      }
      this.job.status = 'running';
      const workers = new AbortController();
      const workerSignal = AbortSignal.any([signal, workers.signal]);
      const nextTimes = new Map();
      const updateNextAt = () => {
        let earliest = Infinity;
        for (const time of nextTimes.values()) earliest = Math.min(earliest, time);
        this.job.nextAt = nextTimes.size ? new Date(earliest).toISOString() : null;
      };
      let reserved = 0;
      let failure;
      await Promise.allSettled(sessions.map(async (session, index) => {
        let nextAt = null;
        try {
          while (reserved < config.limit) {
            workerSignal.throwIfAborted();
            // Reserve before awaiting so concurrent bots cannot exceed the shared limit.
            reserved++;
            if (nextAt !== null) {
              nextTimes.set(index, nextAt);
              updateNextAt();
              await this.sleep(Math.max(0, nextAt - this.now()), workerSignal);
              nextTimes.delete(index);
              updateNextAt();
            }
            workerSignal.throwIfAborted();
            // Measure each bot's interval from its own previous request start.
            // A slow request never overlaps another request from the same bot.
            nextAt = this.now() + config.interval * 1000;
            const id = await session.send(config.message, workerSignal);
            this.job.sent++;
            this.job.bots[index].sent++;
            this.log('success', `${this.job.bots[index].name} · 전송 완료 #${id}`);
          }
        } catch (error) {
          if (!workerSignal.aborted) {
            failure = error;
            workers.abort();
          }
        } finally {
          nextTimes.delete(index);
          updateNextAt();
        }
      }));
      if (failure) throw failure;
      signal.throwIfAborted();
      this.job.status = 'completed';
      this.log('success', `총 ${this.job.sent}건 전송을 완료했습니다.`);
    } catch (error) {
      this.job.status = signal.aborted ? 'stopped' : 'failed';
      this.log(signal.aborted ? 'info' : 'error', signal.aborted ? '실행을 중지했습니다.' : `${error.name === 'TimeoutError' ? '서비스 응답 시간이 초과되었습니다. 전송 여부를 직접 확인하세요.' : error.message}`);
    } finally {
      clearTimeout(deadline);
      await Promise.allSettled(sessions.map(session => Promise.resolve().then(() => session.close())));
      await browser?.close();
      this.job.nextAt = null;
      this.job.endedAt = new Date().toISOString();
    }
  }
}
