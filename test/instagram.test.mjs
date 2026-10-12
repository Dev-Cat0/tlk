import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { InstagramSession, INSTAGRAM_API_VERSION } from '../server/instagram.mjs';
import { validateConfig } from '../server/config.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/http.mjs';

const config = { platform: 'instagram', accountId: '17841400000000000', recipientId: '12345678901234567', accessToken: 'test-secret-token', message: '테스트 DM', interval: 0.25, limit: 3 };
const confirmed = () => new Response(JSON.stringify({ recipient_id: config.recipientId, message_id: 'mid.mock' }));

test('Instagram validates IDs, token and common settings and always uses one sender', () => {
  const parsed = validateConfig({ ...config, botCount: 5 });
  assert.equal(parsed.botCount, 1);
  assert.equal(parsed.channel, config.recipientId);
  for (const patch of [{ platform: 'unknown' }, { accountId: '@someone' }, { recipientId: 'https://instagram.com/name' }, { recipientId: '' }, { accountId: '../me' }, { accessToken: '' }, { accessToken: 'a\nb' }, { accessToken: 'x'.repeat(4097) }, { message: '' }, { interval: -1 }, { limit: 1.5 }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});

test('Instagram sends the official payload using a bearer header and clears its token', async () => {
  const calls = [];
  const session = new InstagramSession({ ...config, fetchImpl: async (...args) => { calls.push(args); return confirmed(); } });
  await session.join(config.recipientId);
  assert.equal(await session.send(config.message), 'mid.mock');
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, `https://graph.instagram.com/${INSTAGRAM_API_VERSION}/${config.accountId}/messages`);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, `Bearer ${config.accessToken}`);
  assert.deepEqual(JSON.parse(request.body), { recipient: { id: config.recipientId }, message: { text: config.message } });
  assert.equal(url.includes(config.accessToken), false);
  session.close();
  assert.equal(session.accessToken, undefined);
});

test('Instagram rejects rate limits, token/permission failures and ambiguous results without retries or secret leaks', async () => {
  for (const [response, message] of [
    [new Response('{"error":{"code":613}}', { status: 429 }), /전송 제한/],
    [new Response(JSON.stringify({ error: { code: 190, message: config.accessToken } }), { status: 400 }), /토큰/],
    [new Response('{"error":{"code":10}}', { status: 400 }), /24시간/],
    [new Response('{"error":{"code":100}}', { status: 400 }), /거절/],
    [new Response('{}'), /전송 결과/],
    [new Response('{"message_id":"mid.other","recipient_id":"999"}'), /전송 결과/],
    [new Response('not json'), /응답 형식/],
  ]) {
    let calls = 0;
    const session = new InstagramSession({ ...config, fetchImpl: async () => { calls++; return response; } });
    await session.join(config.recipientId);
    await assert.rejects(session.send(config.message), error => message.test(error.message) && !error.message.includes(config.accessToken));
    assert.equal(calls, 1);
  }
  const session = new InstagramSession({ ...config, fetchImpl: async () => { throw new Error(config.accessToken); } });
  await session.join(config.recipientId);
  await assert.rejects(session.send(config.message), error => /자동 재시도하지/.test(error.message) && !error.message.includes(config.accessToken));
});

test('Instagram runner counts confirmed sends and exposes no token in any snapshot', async () => {
  const waits = [], sessions = [];
  const runner = new Runner({
    makeSession: () => { throw new Error('wrong platform'); },
    makeInstagramSession: options => { const session = new InstagramSession({ ...options, fetchImpl: async () => confirmed() }); sessions.push(session); return session; },
    now: () => 0, sleep: async ms => waits.push(ms),
  });
  const first = runner.start(config);
  assert.equal(JSON.stringify(first).includes(config.accessToken), false);
  assert.equal(Object.hasOwn(first.config, 'accessToken'), false);
  await runner.pending;
  const result = runner.snapshot();
  assert.equal(result.status, 'completed');
  assert.equal(result.sent, 3);
  assert.equal(result.bots.length, 1);
  assert.deepEqual(waits, [250, 250]);
  assert.equal(sessions[0].accessToken, undefined);
  assert.equal(JSON.stringify(result).includes(config.accessToken), false);
});

test('Instagram stop aborts an in-flight send and does not count it as confirmed', async () => {
  let entered, session;
  const sending = new Promise(resolve => { entered = resolve; });
  const runner = new Runner({ makeInstagramSession: options => {
    session = new InstagramSession({ ...options, fetchImpl: async (_url, { signal }) => {
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
  assert.equal(session.accessToken, undefined);
});

test('HTTP start/status/stop never return the Instagram token and failure stops subsequent sends', async t => {
  let sends = 0;
  const runner = new Runner({ makeInstagramSession: options => new InstagramSession({ ...options, fetchImpl: async () => {
    sends++;
    return new Response(JSON.stringify({ error: { code: 190, message: config.accessToken } }), { status: 400 });
  } }) });
  const { server } = createApp({ origins: [], runner });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(start.status, 202);
  assert.equal((await start.text()).includes(config.accessToken), false);
  await runner.pending;
  for (const [path, method] of [['/api/status', 'GET'], ['/api/stop', 'POST']]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(config.accessToken), false);
    assert.equal(JSON.parse(body).job.status, 'failed');
  }
  assert.equal(sends, 1);
  assert.equal(runner.snapshot().sent, 0);
});
