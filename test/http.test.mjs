import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/http.mjs';
import { Runner } from '../server/runner.mjs';

test('keyless HTTP access, CORS, input validation, start and stop', async t => {
  const runner = new Runner({ makeSession: () => ({ join: async () => {}, send: async () => 'fake-id', close: () => {} }) });
  const { server } = createApp({ origins: ['https://dev-cat0.github.io'], runner });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init) => fetch(`${base}${path}`, init);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/api/status')).status, 200);
  assert.equal((await call('/api/status', { headers: { Origin: 'https://evil.test' } })).status, 403);
  const headers = { Origin: 'https://dev-cat0.github.io', 'Content-Type': 'application/json' };
  const preflight = await call('/api/start', { method: 'OPTIONS', headers: { Origin: headers.Origin } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), headers.Origin);
  assert.equal((await call('/api/start', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await call('/api/start', { method: 'POST', headers, body: JSON.stringify({}) })).status, 400);
  const result = await call('/api/start', { method: 'POST', headers, body: JSON.stringify({ channel: 'test', botCount: 1, prefix: 'bot', message: 'mock only', interval: 0.5, limit: 1001 }) });
  assert.equal(result.status, 202);
  assert.equal((await call('/api/start', { method: 'POST', headers, body: '{}' })).status, 409);
  const stop = await call('/api/stop', { method: 'POST', headers });
  assert.equal(stop.status, 200); assert.equal((await stop.json()).job.status, 'stopped');
  assert.equal((await call('/api/status', { headers })).headers.get('Cache-Control'), 'no-store');
});
