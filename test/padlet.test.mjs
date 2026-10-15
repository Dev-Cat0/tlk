import test from 'node:test';
import assert from 'node:assert/strict';
import { PadletSession, PadletBrowser } from '../server/padlet.mjs';
import { validateConfig } from '../server/config.mjs';
import { Runner } from '../server/runner.mjs';

const config = { platform: 'padlet', boardUrl: 'https://padlet.com/teacher/my-board', subject: '공지', message: '본문', botCount: 3, interval: 0.25, limit: 7 };

test('browser queue releases on failure and skips cancelled waiters', async () => {
  const browser = new PadletBrowser();
  let release, entered, parked = 0, ran = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = browser.run({ park: async () => { parked++; } }, async () => { entered(); await gate; throw new Error('failed'); });
  const failed = assert.rejects(first, /failed/);
  await ready;
  const controller = new AbortController();
  const cancelled = browser.run({}, async () => { ran++; }, controller.signal);
  const aborted = assert.rejects(cancelled, { name: 'AbortError' });
  const last = browser.run({}, async () => { ran++; });
  controller.abort(); release();
  await Promise.all([failed, aborted, last]);
  assert.equal(ran, 1);
  assert.equal(parked, 1);
});

test('connection check prepares every guest but never sends, and closes all sessions', async () => {
  let joined = 0, sent = 0, closed = 0;
  const runner = new Runner({ makePadletSession: () => ({
    join: async () => { joined++; }, send: async () => { sent++; }, close: async () => { closed++; }
  }) });
  runner.start({ ...config, botCount: 5, checkOnly: true });
  await runner.pending;
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(joined, 5);
  assert.equal(sent, 0);
  assert.equal(closed, 5);
  assert.equal(runner.snapshot().sent, 0);
  assert.throws(() => validateConfig({ ...config, checkOnly: 'false' }));
  assert.equal(validateConfig(config).checkOnly, false);
});

test('guest config accepts full custom links, preserves sharing query, and needs no key', () => {
  const parsed = validateConfig({ ...config, boardUrl: config.boardUrl + '?share=1#top', apiKey: 'obsolete-key', sectionId: 'obsolete' });
  assert.equal(parsed.boardUrl, config.boardUrl + '?share=1');
  assert.equal(parsed.botCount, 3);
  assert.equal(Object.hasOwn(parsed, 'apiKey'), false);
  assert.equal(Object.hasOwn(parsed, 'sectionId'), false);
  assert.equal(validateConfig({ ...config, boardUrl: 'https://school.padlet.org/teacher/class' }).platform, 'padlet');
  for (const boardUrl of ['', 'board123', 'http://padlet.com/a', 'https://padlet.com/', 'https://padlet.com.evil.test/a', 'https://evil.test/a', 'https://user:pass@padlet.com/a', 'https://padlet.com:1234/a', 'javascript:alert(1)']) {
    assert.throws(() => validateConfig({ ...config, boardUrl }));
  }
  for (const patch of [{ botCount: 0 }, { botCount: 1.5 }, { botCount: Infinity }, { interval: -1 }, { limit: 1.5 }, { message: '' }, { subject: 'x'.repeat(201) }]) assert.throws(() => validateConfig({ ...config, ...patch }));
});

test('Padlet reuses each guest for its quota and sends before loading the next guest', async () => {
  const joined = [], options = [], waits = [], closed = [], events = [];
  const runner = new Runner({ now: () => 0, sleep: async ms => waits.push(ms), makePadletSession: option => {
    const index = options.push(option) - 1;
    return { join: async (url, name) => { joined.push({ url, name }); events.push(`join-${index}`); }, send: async () => { events.push(`send-${index}`); return 'confirmed'; }, close: async () => closed.push(index) };
  } });
  runner.start(config);
  await runner.pending;
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(runner.snapshot().sent, 7);
  assert.deepEqual(runner.snapshot().bots.map(bot => bot.sent), [3, 2, 2]);
  assert.deepEqual(joined.map(bot => bot.name), ['익명 봇-01', '익명 봇-02', '익명 봇-03']);
  assert.ok(joined.every(bot => bot.url === config.boardUrl));
  assert.ok(options.every(option => option.browser === options[0].browser && option.subject === config.subject));
  assert.deepEqual(waits, [250, 250, 250, 250]);
  assert.deepEqual(closed, [0, 1, 2]);
  assert.deepEqual(events, ['join-0', 'send-0', 'send-0', 'send-0', 'join-1', 'send-1', 'send-1', 'join-2', 'send-2', 'send-2']);
});

test('Padlet failure stops before starting another guest and awaits cleanup', async () => {
  let closed = 0;
  const runner = new Runner({ makePadletSession: () => ({ join: async () => {}, send: async () => { throw new Error('permission denied'); }, close: async () => { await new Promise(resolve => setImmediate(resolve)); closed++; } }) });
  runner.start(config);
  await runner.pending;
  assert.equal(runner.snapshot().status, 'failed');
  assert.equal(runner.snapshot().sent, 0);
  assert.equal(closed, 1);
});

test('Padlet skips unused guests and does not add a timer when sending already took the interval', async () => {
  let now = 0, joined = 0, waits = 0;
  const runner = new Runner({ now: () => now, sleep: async () => { waits++; }, makePadletSession: () => ({
    join: async () => { joined++; }, send: async () => { now += 100; return 'confirmed'; }, close: async () => {}
  }) });
  runner.start({ ...config, botCount: 5, limit: 2, interval: 0.05 });
  await runner.pending;
  assert.equal(joined, 2);
  assert.equal(runner.snapshot().sent, 2);
  runner.start({ ...config, botCount: 1, limit: 4, interval: 0.05 });
  await runner.pending;
  assert.equal(runner.snapshot().sent, 4);
  assert.equal(waits, 0);
});

test('Padlet stop during interval never sends the next post or starts the next guest', async () => {
  let waiting, joined = 0, sent = 0, closed = 0;
  const gate = new Promise(resolve => { waiting = resolve; });
  const runner = new Runner({ now: () => 0, sleep: async (_ms, signal) => {
    waiting();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, makePadletSession: () => ({
    join: async () => { joined++; }, send: async () => { sent++; return 'confirmed'; }, close: async () => { closed++; }
  }) });
  runner.start(config);
  await gate;
  await runner.stop();
  assert.equal(runner.snapshot().status, 'stopped');
  assert.equal(sent, 1);
  assert.equal(joined, 1);
  assert.equal(closed, 1);
});

test('stop during browser startup releases a context created after cancellation', async () => {
  let entered, release, closed = 0;
  const starting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const session = new PadletSession({ browser: { get: async () => ({ newContext: async () => { entered(); await blocked; return { close: async () => { closed++; } }; } }) } });
  const joining = session.join(config.boardUrl, 'guest', controller.signal);
  await starting;
  controller.abort(); release();
  await assert.rejects(joining, { name: 'AbortError' });
  await session.close(); await session.close();
  assert.equal(closed, 1);
});
