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
  for (const [provider, cmd] of Object.entries(CLI)) {
    if (provider !== 'agy') installed.set(provider, (await cliOutput(cmd!, ['--version'])) !== null);
  }
  const list = [...readModels(join(root, 'models.json')), ...readModels(join(root, 'models.local.json'))];
  // agy: its model list is the installation check (it can take a while: it asks Google for the list).
  const agyOut = await cliOutput('agy', ['models'], 60000);
  const agyModels = parseAgyModels(agyOut ?? '');
  installed.set('agy', agyOut !== null);
  if (agyOut !== null && !agyModels.length) console.log(`agy is installed but \`agy models\` listed nothing:\n${agyOut.slice(0, 500)}`);
  list.push(...agyModels);
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
  let lastSummary = '';
  for (;;) {
    try {
      const r = await api.req('POST', '/api/admin/pool/hello', { host: hostname(), catalog, running: [...running.keys()] });
      if (offline) console.log('Server reachable again.');
      offline = false;
      const summary = describePool(r, cfg.server);
      if (summary !== lastSummary) console.log(`\x1b[90m${new Date().toTimeString().slice(0, 8)}\x1b[0m ${summary}`);
      lastSummary = summary;
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

/** One line (or a few) that says what the launcher is waiting for. Printed whenever it changes. */
function describePool(r: any, server: string): string {
  const waiting: string[] = r.waiting ?? [];
  const busy: string[] = r.busy ?? [];
  const lobbies: { id: string; players: number; seats: number; free: number }[] = r.lobbies ?? [];
  const lines: string[] = [];
  lines.push(`Waiting list: ${waiting.length ? waiting.join(', ') : '(empty)'}${busy.length ? ` | playing: ${busy.join(', ')}` : ''}`);
  if (!waiting.length && !busy.length) lines.push(`   → add players on ${server.replace(/\/$/, '')}/players (click + next to a model)`);
  if (lobbies.length) {
    lines.push(`   open lobbies: ${lobbies.map((l) => `${l.id} ${l.players}/${l.seats || '∞'}${l.seats ? ` (${l.free} free)` : ''}`).join(', ')}`);
  } else if (waiting.length) {
    lines.push('   → no open lobby: create one on the Games page (keep "AI players from the waiting list may join" checked)');
  }
  if (r.closedLobbies?.length) lines.push(`   lobbies closed to the waiting list: ${r.closedLobbies.join(', ')}`);
  for (const e of r.errors ?? []) lines.push(`   ✗ ${e}  (Retry on the AI players page)`);
  return lines.join('\n');
}
