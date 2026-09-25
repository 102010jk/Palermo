import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local IPC path of a game server running on this machine (must match apps/server/src/pipe.ts),
 * or undefined for remote servers.
 */
export function localPipeFor(mcpUrl: string): string | undefined {
  const u = new URL(mcpUrl);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) return undefined;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return process.platform === 'win32' ? `\\\\.\\pipe\\palermo-${port}` : join(tmpdir(), `palermo-${port}.sock`);
}
