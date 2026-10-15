import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PadletSession } from '../server/padlet.mjs';
import { validateConfig } from '../server/config.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/http.mjs';

const config = { platform: 'padlet', boardId: 'abcd1234efgh5678', subject: '공지', sectionId: 'sec_xPdL4geL0PReqpwK', apiKey: 'test-secret-key', message: '테스트 게시물', interval: 0.25, limit: 3 };
const confirmed = () => new Response(JSON.stringify({ data: { type: 'post', id: 'post_mock', relationships: { board: { data: { id: config.boardId } } } } }));

test('Padlet normalizes board links and rejects unsafe or custom links without IDs', () => {
  for (const boardId of [config.boardId, 'board_abcd1234efgh5678', 'abcd1234efgh56789012']) {
    assert.equal(validateConfig({ ...config, boardId }).boardId, boardId);
  }
  for (const host of ['padlet.com', 'school.padlet.org']) {
    const url = `https://${host}/teacher/class-${config.boardId}/?share=1#top`;
    const parsed = validateConfig({ ...config, boardId: url });
    assert.equal(parsed.boardId, config.boardId);
    assert.equal(parsed.boardUrl, `https://${host}/teacher/class-${config.boardId}`);
  }
  for (const boardId of ['https://evil.test/' + config.boardId, 'https://padlet.com.evil.test/' + config.boardId, 'https://user:pass@padlet.com/' + config.boardId, 'http://padlet.com/' + config.boardId, 'https://padlet.com:1234/' + config.boardId, 'https://padlet.com/name/custom', 'javascript:alert(1)']) {
    assert.throws(() => validateConfig({ ...config, boardId }));
  }
  assert.throws(() => validateConfig({ ...config, platform: 'instagram' }), /지원하지 않는/);
});

test('Padlet omits optional subject and section and handles plain HTTP errors', async () => {
  let body;
  const session = new PadletSession({ apiKey: config.apiKey, fetchImpl: async (_url, request) => { body = JSON.parse(request.body); return confirmed(); } });
  await session.join(config.boardId);
  await session.send('본문');
  assert.deepEqual(body, { data: { type: 'post', attributes: { content: { body: '본문' } } } });
  for (const [status, pattern] of [[401, /API 키/], [403, /권한/], [404, /찾을 수/], [429, /전송 제한/], [500, /거절/]]) {
    session.fetch = async () => new Response(config.apiKey, { status });
    await assert.rejects(session.send('본문'), error => pattern.test(error.message) && !error.message.includes(config.apiKey));
  }
  session.fetch = async () => new Response(JSON.stringify({ data: { type: 'post', id: 'post_other', relationships: { board: { data: { id: 'other-board' } } } } }));
  await assert.rejects(session.send('본문'), /게시 결과/);
  session.close();
});

test('Padlet validates IDs, key and common settings and always uses one sender', () => {
  const parsed = validateConfig({ ...config, botCount: 5 });
  assert.equal(parsed.botCount, 1);
  assert.equal(parsed.channel, config.boardId);
  for (const patch of [{ platform: 'unknown' }, { boardId: 'https://padlet.com/name' }, { boardId: '' }, { boardId: '../me' }, { apiKey: '' }, { apiKey: 'a\nb' }, { apiKey: 'x'.repeat(4097) }, { subject: 'x'.repeat(201) }, { sectionId: '../invalid' }, { message: '' }, { interval: -1 }, { limit: 1.5 }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});

test('Padlet sends the official payload using an API key header and clears its key', async () => {
  const calls = [];
  const session = new PadletSession({ ...config, fetchImpl: async (...args) => { calls.push(args); return confirmed(); } });
  await session.join(config.boardId);
  assert.equal(await session.send(config.message), 'post_mock');
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, `https://api.padlet.dev/v1/boards/${config.boardId}/posts`);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers['X-API-KEY'], config.apiKey);
  assert.deepEqual(JSON.parse(request.body), { data: { type: 'post', attributes: { content: { subject: config.subject, body: config.message } }, relationships: { section: { data: { id: config.sectionId } } } } });
  assert.equal(url.includes(config.apiKey), false);
  session.close();
  assert.equal(session.apiKey, undefined);
});

test('Padlet rejects rate limits, key/permission failures and ambiguous results without retries or secret leaks', async () => {
  for (const [response, message] of [
    [new Response('{"error":{"code":613}}', { status: 429 }), /전송 제한/],
    [new Response(JSON.stringify({ error: { code: 190, message: config.apiKey } }), { status: 401 }), /API 키/],
    [new Response('{"error":{"code":10}}', { status: 403 }), /권한/],
    [new Response('{"error":{"code":100}}', { status: 400 }), /거절/],
    [new Response('{}'), /게시 결과/],
    [new Response('{"data":{"type":"board","id":"abcd1234efgh5678"}}'), /게시 결과/],
    [new Response('not json'), /응답 형식/],
  ]) {
    let calls = 0;
    const session = new PadletSession({ ...config, fetchImpl: async () => { calls++; return response; } });
    await session.join(config.boardId);
    await assert.rejects(session.send(config.message), error => message.test(error.message) && !error.message.includes(config.apiKey));
    assert.equal(calls, 1);
  }
  const session = new PadletSession({ ...config, fetchImpl: async () => { throw new Error(config.apiKey); } });
  await session.join(config.boardId);
  await assert.rejects(session.send(config.message), error => /자동 재시도하지/.test(error.message) && !error.message.includes(config.apiKey));
});

test('Padlet runner counts confirmed sends and exposes no key in any snapshot', async () => {
  const waits = [], sessions = [];
  const runner = new Runner({
    makeSession: () => { throw new Error('wrong platform'); },
    makePadletSession: options => { const session = new PadletSession({ ...options, fetchImpl: async () => confirmed() }); sessions.push(session); return session; },
    now: () => 0, sleep: async ms => waits.push(ms),
  });
  const first = runner.start(config);
  assert.equal(JSON.stringify(first).includes(config.apiKey), false);
  assert.equal(Object.hasOwn(first.config, 'apiKey'), false);
  await runner.pending;
  const result = runner.snapshot();
  assert.equal(result.status, 'completed');
  assert.equal(result.sent, 3);
  assert.equal(result.bots.length, 1);
  assert.deepEqual(waits, [250, 250]);
  assert.equal(sessions[0].apiKey, undefined);
  assert.equal(JSON.stringify(result).includes(config.apiKey), false);
});

test('Padlet stop aborts an in-flight send and does not count it as confirmed', async () => {
  let entered, session;
  const sending = new Promise(resolve => { entered = resolve; });
  const runner = new Runner({ makePadletSession: options => {
    session = new PadletSession({ ...options, fetchImpl: async (_url, { signal }) => {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    return session;
  } });
  runner.start(config);
  await sending;
  await runner.stop();
  assert.equal(runner.snapshot().status, 'stopped');
  assert.equal(runner.snapshot().sent, 0);
  assert.equal(session.apiKey, undefined);
});

test('HTTP start/status/stop never return the Padlet key and failure stops subsequent sends', async t => {
  let sends = 0;
  const runner = new Runner({ makePadletSession: options => new PadletSession({ ...options, fetchImpl: async () => {
    sends++;
    return new Response(JSON.stringify({ error: { code: 190, message: config.apiKey } }), { status: 400 });
  } }) });
  const { server } = createApp({ origins: [], runner });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(start.status, 202);
  assert.equal((await start.text()).includes(config.apiKey), false);
  await runner.pending;
  for (const [path, method] of [['/api/status', 'GET'], ['/api/stop', 'POST']]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(config.apiKey), false);
    assert.equal(JSON.parse(body).job.status, 'failed');
  }
  assert.equal(sends, 1);
  assert.equal(runner.snapshot().sent, 0);
});
