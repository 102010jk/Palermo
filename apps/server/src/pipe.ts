import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Conventional local IPC path for a server on `port`. The runner computes the same path from the server URL. */
export function localPipePath(port: number): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\palermo-${port}` : join(tmpdir(), `palermo-${port}.sock`);
}
