import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { TlkSession } from './tlk.mjs';
import { validateConfig } from './config.mjs';

export class Runner {
  constructor({ makeSession = () => new TlkSession(), sleep = (ms, signal) => delay(ms, undefined, { signal }), maxDuration = 6 * 3600_000 } = {}) {
    this.makeSession = makeSession;
    this.sleep = sleep;
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
    this.log('info', `#${config.channel} 연결을 시작합니다.`);
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
    const deadline = setTimeout(() => { this.log('info', '최대 실행 시간(6시간)에 도달했습니다.'); this.controller.abort(); }, this.maxDuration);
    deadline.unref?.();
    try {
      for (let i = 0; i < config.botCount; i++) {
        signal.throwIfAborted();
        const session = this.makeSession();
        sessions.push(session);
        const name = `${config.prefix}-${String(i + 1).padStart(2, '0')}`;
        await session.join(config.channel, name, signal);
        signal.throwIfAborted();
        this.job.bots.push({ name, sent: 0 });
        this.log('info', `${name} 참가 완료`);
      }
      this.job.status = 'running';
      for (let i = 0; i < config.limit; i++) {
        signal.throwIfAborted();
        const index = i % sessions.length;
        this.job.nextAt = null;
        const id = await sessions[index].send(config.message, signal);
        this.job.sent++;
        this.job.bots[index].sent++;
        this.log('success', `${this.job.bots[index].name} · 전송 완료 #${id}`);
        signal.throwIfAborted();
        if (i + 1 < config.limit) {
          this.job.nextAt = new Date(Date.now() + config.interval * 1000).toISOString();
          await this.sleep(config.interval * 1000, signal);
        }
      }
      this.job.status = 'completed';
      this.log('success', `총 ${this.job.sent}건 전송을 완료했습니다.`);
    } catch (error) {
      this.job.status = signal.aborted ? 'stopped' : 'failed';
      this.log(signal.aborted ? 'info' : 'error', signal.aborted ? '실행을 중지했습니다.' : `${error.name === 'TimeoutError' ? 'tlk.io 응답 시간이 초과되었습니다. 전송 여부를 채널에서 확인하세요.' : error.message}`);
    } finally {
      clearTimeout(deadline);
      for (const session of sessions) session.close();
      this.job.nextAt = null;
      this.job.endedAt = new Date().toISOString();
    }
  }
}
