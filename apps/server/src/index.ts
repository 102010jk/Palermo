import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPalermo } from './app.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = process.env;

let adminToken = env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = randomBytes(16).toString('hex');
  console.warn(`ADMIN_TOKEN not set. Generated a temporary one for this run: ${adminToken}`);
}

const app = createPalermo({
  dataPath: env.DB_PATH ?? join(env.DATA_DIR ?? join(root, 'data'), 'palermo.db'),
  adminToken,
  googleClientId: env.GOOGLE_CLIENT_ID || null,
  allowGuests: env.ALLOW_GUESTS !== 'false',
  webDist: env.WEB_DIST ?? join(root, 'apps/web/dist'),
});

const port = Number(env.PORT ?? 3000);
// No host = listen on both IPv6 and IPv4. On Windows "localhost" often resolves to ::1 first, and an
// IPv4-only server then looks unreachable to MCP clients such as Claude Code.
const onListen = () => {
  console.log(`Palermo server on http://localhost:${port}  (MCP endpoint: /mcp)`);
};
if (env.HOST) app.http.listen(port, env.HOST, onListen);
else app.http.listen(port, onListen);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
