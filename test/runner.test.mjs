import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../server/runner.mjs';
import { validateConfig } from '../server/config.mjs';
import { TlkSession, parseChannel } from '../server/tlk.mjs';

const config = { channel: 'my-room', botCount: 2, prefix: 'notice-bot', interval: 5, limit: 4, message: '안녕하세요' };
const html = '<meta name="csrf-token" content="test-csrf"><script>Talkio.Variables.chat_id = \'123\'; var settings = {"allow_anonymous":true};</script>';

test('configuration accepts tlk URLs and rejects invalid inputs', () => {
  assert.equal(validateConfig({ ...config, channel: 'https://tlk.io/my-room/' }).channel, 'my-room');
  for (const patch of [{ channel: 'https://evil.test/room' }, { channel: 'https://tlk.io/room?x=1' }, { channel: '../admin' }, { channel: 'a/b' }, { botCount: 0 }, { botCount: 6 }, { interval: -1 }, { interval: Infinity }, { interval: NaN }, { limit: 0 }, { limit: 1.5 }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { message: '  ' }, { message: 'x'.repeat(1001) }, { prefix: '<script>' }]) assert.throws(() => validateConfig({ ...config, ...patch }));
});
test('intervals below five seconds and counts above one thousand are accepted', async () => {
  assert.equal(validateConfig({ ...config, interval: 0 }).interval, 0);
  assert.equal(validateConfig({ ...config, interval: 0.25, limit: 100000 }).limit, 100000);
  const waits = [];
  const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => 'mock', close: () => {} }), now: () => 0, sleep: async ms => { waits.push(ms); } });
  runner.start({ ...config, interval: 0.25, limit: 1001 });
  await runner.pending;
  assert.equal(runner.snapshot().sent, 1001);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(waits.length, 999);
  assert.ok(waits.every(ms => ms === 250));
  assert.equal(runner.snapshot().logs.length, 200);
});
test('runner joins separate sessions, gives each bot its own interval, and finishes at limit', async () => {
  const sent = [], joined = [], waits = [], closed = [];
  let number = 0;
  const runner = new Runner({ makeSession: () => { const i = number++; return { join: async (channel, name) => joined.push([i, channel, name]), send: async message => { sent.push([i, message]); return sent.length; }, close: () => closed.push(i) }; }, now: () => 0, sleep: async ms => waits.push(ms) });
  runner.start(config);
  assert.throws(() => runner.start(config), /이미 실행/);
  await runner.pending;
  assert.deepEqual(joined.map(row => row[2]), ['notice-bot-01', 'notice-bot-02']);
  assert.deepEqual(sent.map(row => row[0]), [0, 1, 0, 1]);
  assert.deepEqual(waits, [5000, 5000]);
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
  assert.equal(runner.snapshot().sent, 2);
  assert.equal(runner.snapshot().status, 'stopped');
  runner.start({ ...config, limit: 1 }); await runner.pending;
  assert.equal(runner.snapshot().status, 'completed');
});
test('upstream failures stop without retries or fabricated successes', async () => {
  let sends = 0;
  const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => { sends++; throw new Error('429'); }, close: () => {} }) });
  runner.start(config); await runner.pending;
  assert.equal(sends, 2); assert.equal(runner.snapshot().sent, 0); assert.equal(runner.snapshot().status, 'failed');
});

const flush = () => new Promise(resolve => setImmediate(resolve));

function manualClock() {
  let time = 0;
  const waiting = new Set();
  return {
    now: () => time,
    sleep: (ms, signal) => {
      signal.throwIfAborted();
      if (ms === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = { at: time + ms, finish: () => { cleanup(); resolve(); } };
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { waiting.delete(entry); signal.removeEventListener('abort', abort); };
        waiting.add(entry);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    advance: async ms => {
      time += ms;
      for (const entry of waiting) if (entry.at <= time) entry.finish();
      await flush();
    },
  };
}

test('five bots send immediately and a slow bot does not delay the other four', async () => {
  const clock = manualClock();
  const sent = [];
  let number = 0, releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const runner = new Runner({ ...clock, makeSession: () => {
    const index = number++;
    let count = 0;
    return {
      join: async () => {},
      send: async () => {
        sent.push([index, clock.now()]);
        if (index === 0 && count++ === 0) await slow;
        return 'confirmed';
      },
      close: () => {},
    };
  } });
  runner.start({ ...config, botCount: 5, limit: 14 });
  await flush();
  assert.deepEqual(sent, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.equal(runner.snapshot().nextAt, new Date(5000).toISOString());
  await clock.advance(4999);
  assert.equal(sent.length, 5);
  await clock.advance(1);
  assert.deepEqual(sent.slice(5), [[1, 5000], [2, 5000], [3, 5000], [4, 5000]]);
  await clock.advance(1000);
  releaseSlow();
  await flush();
  assert.deepEqual(sent.at(-1), [0, 6000]);
  assert.equal(runner.snapshot().nextAt, new Date(10000).toISOString());
  await clock.advance(4000);
  await runner.pending;
  assert.deepEqual(sent.slice(10), [[1, 10000], [2, 10000], [3, 10000], [4, 10000]]);
  assert.equal(runner.snapshot().sent, 14);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(runner.snapshot().nextAt, null);
});

test('five bots independently start requests together every 0.1 seconds', async () => {
  const clock = manualClock();
  const sends = Array.from({ length: 5 }, () => []);
  const releases = [];
  let number = 0, inFlight = 0, peakInFlight = 0;
  const runner = new Runner({ ...clock, makeSession: () => {
    const index = number++;
    return {
      join: async () => {}, close: () => {},
      send: async () => {
        sends[index].push(clock.now());
        peakInFlight = Math.max(peakInFlight, ++inFlight);
        if (sends[index].length === 1) await new Promise(resolve => { releases[index] = resolve; });
        inFlight--;
        return 'confirmed';
      },
    };
  } });
  runner.start({ ...config, botCount: 5, interval: 0.1, limit: 10 });
  await flush();
  // All five requests are in flight before any response is received.
  assert.equal(inFlight, 5);
  assert.deepEqual(sends, [[0], [0], [0], [0], [0]]);
  for (const index of [3, 0, 4, 1, 2]) {
    releases[index]();
    await flush();
    await clock.advance(10);
  }
  await clock.advance(49);
  assert.deepEqual(sends, [[0], [0], [0], [0], [0]]);
  await clock.advance(1);
  await runner.pending;
  assert.deepEqual(sends, [[0, 100], [0, 100], [0, 100], [0, 100], [0, 100]]);
  assert.equal(peakInFlight, 5);
  assert.equal(runner.snapshot().sent, 10);
  assert.equal(runner.snapshot().status, 'completed');
});

test('request duration is included in each bot interval', async () => {
  const clock = manualClock();
  const sent = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const runner = new Runner({ ...clock, makeSession: () => ({
    join: async () => {}, close: () => {},
    send: async () => { sent.push(clock.now()); if (sent.length === 1) await first; return 'confirmed'; },
  }) });
  runner.start({ ...config, botCount: 1, limit: 2 });
  await flush();
  await clock.advance(2000);
  release();
  await flush();
  assert.equal(runner.snapshot().nextAt, new Date(5000).toISOString());
  await clock.advance(3000);
  await runner.pending;
  assert.deepEqual(sent, [0, 5000]);
});

test('concurrent bots respect small and uneven shared limits, including zero interval', async () => {
  for (const limit of [1, 3, 7, 12]) {
    let sends = 0;
    const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => ++sends, close: () => {} }) });
    runner.start({ ...config, botCount: 5, interval: 0, limit });
    await runner.pending;
    assert.equal(sends, limit);
    assert.equal(runner.snapshot().sent, limit);
    assert.equal(runner.snapshot().bots.reduce((sum, bot) => sum + bot.sent, 0), limit);
    assert.equal(runner.snapshot().status, 'completed');
  }
});

test('a failed bot cancels peer waits and requests before sessions close or a new run starts', async () => {
  const clock = manualClock();
  let number = 0, fail, releasePeer;
  const failed = new Promise((_, reject) => { fail = reject; });
  const peer = new Promise(resolve => { releasePeer = resolve; });
  const closed = [], sent = [];
  let peerAborted = false;
  const runner = new Runner({ ...clock, makeSession: () => {
    const index = number++;
    return {
      join: async () => {},
      send: async (_message, signal) => {
        sent.push(index);
        if (index === 0) return failed;
        if (index === 1) {
          signal.addEventListener('abort', () => { peerAborted = true; }, { once: true });
          await peer;
          signal.throwIfAborted();
        }
        return 'confirmed';
      },
      close: () => closed.push(index),
    };
  } });
  runner.start({ ...config, botCount: 3, limit: 10 });
  await flush();
  fail(new Error('upstream failure'));
  await flush();
  assert.equal(peerAborted, true);
  assert.deepEqual(closed, []);
  assert.throws(() => runner.start(config), /이미 실행/);
  releasePeer();
  await runner.pending;
  assert.deepEqual(closed, [0, 1, 2]);
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(runner.snapshot().sent, 1);
  assert.equal(runner.snapshot().status, 'failed');
  assert.equal(runner.snapshot().nextAt, null);
  assert.equal(runner.snapshot().logs.at(-1).text, 'upstream failure');
  await clock.advance(5000);
  assert.deepEqual(sent, [0, 1, 2]);
  runner.start({ ...config, limit: 1 });
  await runner.pending;
  assert.equal(runner.snapshot().status, 'completed');
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
