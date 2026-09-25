import spawn from 'cross-spawn';

const SECRET_ENV = ['PALERMO_ADMIN_TOKEN', 'ADMIN_TOKEN'];

/** Spawn a CLI, stream stdout line by line, resolve with the exit code. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; onLine: (line: string) => void; onErr?: (line: string) => void; timeoutMs?: number },
): Promise<number | null> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    // Never leak the game master's secrets to a player.
    for (const k of SECRET_ENV) delete env[k];
    // `undefined` in opts.env means "remove this variable".
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k];
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const split = (fn: (l: string) => void) => {
      let buf = '';
      return (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) fn(line);
        }
      };
    };
    child.stdout?.on('data', split(opts.onLine));
    child.stderr?.on('data', split(opts.onErr ?? (() => {})));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.on('error', (e) => {
      opts.onErr?.(`spawn failed: ${e.message}`);
      if (timer) clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(code);
    });
  });
}

export function tryJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function short(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}
