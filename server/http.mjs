import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Runner } from './runner.mjs';

export function createApp({ token, origins, runner = new Runner() }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters.');
  const digest = value => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${token}`);
  const failures = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) return reply(403, { error: '허용되지 않은 사이트입니다.' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.writeHead(204); return res.end();
    }
    if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true, service: 'tlk-runner' });
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, value] of failures) if (value.until < now) failures.delete(key);
    if ((failures.get(ip)?.count ?? 0) >= 30) return reply(429, { error: '인증 시도가 너무 많습니다. 1분 뒤 다시 연결하세요.' });
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
      if (failures.size > 5000) failures.clear();
      const prior = failures.get(ip);
      failures.set(ip, { count: (prior?.count ?? 0) + 1, until: prior?.until ?? now + 60_000 });
      return reply(401, { error: '서버 키가 올바르지 않습니다.' });
    }
    try {
      if (req.url === '/api/status' && req.method === 'GET') return reply(200, { job: runner.snapshot() });
      if (req.url === '/api/stop' && req.method === 'POST') return reply(200, { job: await runner.stop() });
      if (req.url === '/api/start' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON 요청이 필요합니다.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) { reply(413, { error: '요청이 너무 큽니다.' }); req.resume(); return; }
          chunks.push(chunk);
        }
        let config;
        try { config = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: '올바른 JSON이 아닙니다.' }); }
        return reply(202, { job: runner.start(config) });
      }
      reply(404, { error: '찾을 수 없는 경로입니다.' });
    } catch (error) { reply(error.status ?? 400, { error: error.message }); }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return { server, runner };
}
