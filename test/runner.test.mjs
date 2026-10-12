import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../server/runner.mjs';
import { validateConfig } from '../server/config.mjs';
import { TlkSession, parseChannel } from '../server/tlk.mjs';

const config = { channel: 'my-room', botCount: 2, prefix: 'notice-bot', interval: 5, limit: 4, message: '안녕하세요' };
const html = '<meta name="csrf-token" content="test-csrf"><script>Talkio.Variables.chat_id = \'123\'; var settings = {"allow_anonymous":true};</script>';

test('configuration accepts tlk URLs and rejects unsafe or unbounded inputs', () => {
  assert.equal(validateConfig({ ...config, channel: 'https://tlk.io/my-room/' }).channel, 'my-room');
  for (const patch of [{ channel: 'https://evil.test/room' }, { channel: 'https://tlk.io/room?x=1' }, { channel: '../admin' }, { channel: 'a/b' }, { botCount: 0 }, { botCount: 6 }, { interval: 0 }, { interval: 5.5 }, { limit: 1001 }, { message: '  ' }, { message: 'x'.repeat(1001) }, { prefix: '<script>' }]) assert.throws(() => validateConfig({ ...config, ...patch }));
});
test('runner joins separate sessions, rotates bots, spaces messages, and finishes at limit', async () => {
  const sent = [], joined = [], waits = [], closed = [];
  let number = 0;
  const runner = new Runner({ makeSession: () => { const i = number++; return { join: async (channel, name) => joined.push([i, channel, name]), send: async message => { sent.push([i, message]); return sent.length; }, close: () => closed.push(i) }; }, sleep: async ms => waits.push(ms) });
  runner.start(config);
  assert.throws(() => runner.start(config), /이미 실행/);
  await runner.pending;
  assert.deepEqual(joined.map(row => row[2]), ['notice-bot-01', 'notice-bot-02']);
  assert.deepEqual(sent.map(row => row[0]), [0, 1, 0, 1]);
  assert.deepEqual(waits, [5000, 5000, 5000]);
  assert.deepEqual(closed, [0, 1]);
  assert.equal(runner.snapshot().sent, 4);
  assert.equal(runner.snapshot().status, 'completed');
});
test('stop during joining prevents every send and releases all sessions', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let sends = 0, closes = 0;
  const runner = new Runner({ makeSession: () => ({ join: async (_c, _n, signal) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }, send: async () => { sends++; }, close: () => closes++ }) });
  runner.start(config); await started; await runner.stop();
  assert.equal(sends, 0); assert.equal(closes, 1); assert.equal(runner.snapshot().status, 'stopped');
});
test('stop during interval prevents the next send and permits a subsequent run', async () => {
  let notify;
  const sleeping = new Promise(resolve => { notify = resolve; });
  const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => '1', close: () => {} }), sleep: async (_ms, signal) => { notify(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
  runner.start(config); await sleeping; await runner.stop();
  assert.equal(runner.snapshot().sent, 1);
  assert.equal(runner.snapshot().status, 'stopped');
  runner.start({ ...config, limit: 1 }); await runner.pending;
  assert.equal(runner.snapshot().status, 'completed');
});
test('upstream failures stop without retries or fabricated successes', async () => {
  let sends = 0;
  const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => { sends++; throw new Error('429'); }, close: () => {} }) });
  runner.start(config); await runner.pending;
  assert.equal(sends, 1); assert.equal(runner.snapshot().sent, 0); assert.equal(runner.snapshot().status, 'failed');
});
test('invalid upstream HTML and anonymous restrictions fail closed', () => {
  assert.deepEqual(parseChannel(html), { csrf: 'test-csrf', chatId: '123' });
  assert.throws(() => parseChannel('<html>challenge</html>'));
  assert.throws(() => parseChannel(html.replace('true', 'false')), /익명 참가/);
});
test('adapter preserves cookies, CSRF, endpoint and body; accepts confirmed message IDs', async () => {
  const calls = [];
  const responses = [new Response(html, { headers: { 'Set-Cookie': '_tlkio_session=first; HttpOnly' } }), new Response(JSON.stringify({ token: 'user', nickname: 'notice-bot-01' }), { headers: { 'Set-Cookie': '_tlkio_session=second; HttpOnly' } }), new Response(JSON.stringify({ id: 42 }))];
  const session = new TlkSession({ fetchImpl: async (...args) => { calls.push(args); return responses.shift(); } });
  await session.join('my-room', 'notice-bot-01', new AbortController().signal);
  assert.equal(await session.send('hello'), '42');
  assert.equal(calls[1][0], 'https://tlk.io/api/participant');
  assert.equal(calls[1][1].headers.Cookie, '_tlkio_session=first');
  assert.equal(calls[2][1].headers.Cookie, '_tlkio_session=second');
  assert.equal(calls[2][1].headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(calls[2][0], 'https://tlk.io/api/chats/123/messages');
  assert.deepEqual(JSON.parse(calls[2][1].body), { body: 'hello' });
  assert.equal(calls[2][1].redirect, 'error');
  session.close(); assert.equal(session.cookies.size, 0);
});
test('adapter does not accept a rate limit or ambiguous send as success', async () => {
  for (const response of [new Response('{}', { status: 429 }), new Response('{}')]) {
    const session = new TlkSession({ fetchImpl: async () => response });
    await assert.rejects(() => session.send('hello'));
  }
});
