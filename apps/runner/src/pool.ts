import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Api } from './api.ts';
import { launchAgent, type RunnerConfig } from './index.ts';
import { cliOutput } from './proc.ts';
import type { AgentProvider, AgentSpec } from './types.ts';

interface CatalogEntry {
  provider: AgentProvider;
  model: string;
  label: string;
}

interface Assignment {
  pickId: string;
  gameId: string;
  token: string;
  accountId: string;
  name: string;
  provider: AgentProvider;
  model: string;
}

const CLI: Partial<Record<AgentProvider, string>> = { claude: 'claude', codex: 'codex', agy: 'agy', gemini: 'gemini' };
const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96];
const POLL_MS = 3000;

function readModels(path: string): CatalogEntry[] {
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, 'utf8')).models ?? []) as CatalogEntry[];
  } catch (e) {
    console.warn(`Ignoring ${path}: ${(e as Error).message}`);
    return [];
  }
}

/** "gemini-3.8-flash-high     Gemini 3.8 Flash (High)" lines of `agy models`. */
export function parseAgyModels(out: string): CatalogEntry[] {
  return out
    .split(/\r?\n/)
    .map((l) => /^\s*([a-z0-9][\w.-]+)\s{2,}(.+?)\s*$/i.exec(l))
    // Model slugs are lower-case with a dash ("gemini-3.8-flash-high"); skips headers such as "SLUG  NAME".
    .filter((m): m is RegExpExecArray => !!m && /^[a-z0-9][a-z0-9._]*-[a-z0-9._-]+$/.test(m[1]))
    .map((m) => ({ provider: 'agy' as const, model: m[1], label: m[2] }));
}

/** What this PC can run: models.json (+ models.local.json) for installed CLIs, plus everything `agy models` lists. */
export async function buildCatalog(root: string): Promise<CatalogEntry[]> {
  const installed = new Map<string, boolean>();
  for (const [provider, cmd] of Object.entries(CLI)) installed.set(provider, !!(await cliOutput(cmd!, ['--version'])));
  const list = [...readModels(join(root, 'models.json')), ...readModels(join(root, 'models.local.json'))];
  if (installed.get('agy')) list.push(...parseAgyModels((await cliOutput('agy', ['models'])) ?? ''));
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const e of list) {
    const key = `${e.provider}:${e.model}`;
    if (seen.has(key) || !e.provider || !e.model) continue;
    if (e.provider !== 'bot' && !installed.get(e.provider)) continue;
    seen.add(key);
    out.push({ provider: e.provider, model: e.model, label: e.label || e.model });
  }
  const missing = [...installed].filter(([, ok]) => !ok).map(([p]) => CLI[p as AgentProvider]);
  if (missing.length) console.log(`Not installed (their models are hidden): ${missing.join(', ')}`);
  return out;
}

/**
 * `runner --pool`: waits for the game master to pick AI players on the web (AI players page) and seats them in
 * the first lobby with free seats. Runs until closed.
 */
export async function runPool(cfg: RunnerConfig, api: Api, skill: string, root: string): Promise<void> {
  const catalog = await buildCatalog(root);
  console.log(`AI launcher on ${hostname()} – ${catalog.length} models available:`);
  for (const e of catalog) console.log(`  ${e.provider.padEnd(6)} ${e.model.padEnd(28)} ${e.label}`);
  console.log(`\nPick players on ${cfg.server.replace(/\/$/, '')}/players – they join the first lobby with free seats.`);
  console.log('Keep this window open. Ctrl+C stops the launcher (running agents stop too).\n');

  const running = new Map<string, Promise<void>>();
  let n = 0;
  let offline = false;
  for (;;) {
    try {
      const r = await api.req('POST', '/api/admin/pool/hello', { host: hostname(), catalog, running: [...running.keys()] });
      if (offline) console.log('Server reachable again.');
      offline = false;
      for (const a of (r.assignments ?? []) as Assignment[]) {
        running.set(a.pickId, play(a, n++).finally(() => running.delete(a.pickId)));
      }
    } catch (e) {
      if (!offline) console.log(`Server ${cfg.server} not reachable (${(e as Error).message}); retrying…`);
      offline = true;
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }

  async function play(a: Assignment, i: number): Promise<void> {
    console.log(`→ ${a.name} (${a.provider} ${a.model}) joins ${a.gameId}`);
    const game = await api.game(a.gameId).catch(() => null);
    const spec: AgentSpec = { name: a.name, provider: a.provider, model: a.model, maxRestarts: a.provider === 'agy' ? 6 : 3 };
    const runDir = resolve(cfg.runDir ?? join(tmpdir(), 'palermo-runs'), a.gameId);
    mkdirSync(runDir, { recursive: true });
    let error: string | undefined;
    try {
      error = await launchAgent({
        cfg,
        api,
        skill,
        spec,
        gameId: a.gameId,
        token: a.token,
        accountId: a.accountId,
        runDir,
        freedomMode: game?.view?.settings?.freedomMode === true,
        color: COLORS[i % COLORS.length],
      });
    } catch (e) {
      error = (e as Error).message;
    }
    console.log(error ? `✗ ${a.name}: ${error}` : `✓ ${a.name} finished ${a.gameId}`);
    await api.req('POST', '/api/admin/pool/finish', { pickId: a.pickId, error }).catch(() => {});
  }
}
