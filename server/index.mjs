import { createApp } from './http.mjs';
const origins = (process.env.ALLOWED_ORIGINS || 'https://dev-cat0.github.io').split(',').map(value => value.trim()).filter(Boolean);
const { server, runner } = createApp({ token: process.env.ADMIN_TOKEN, origins });
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`tlk-runner listening on port ${port}`));
async function shutdown() { await runner.stop(); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
