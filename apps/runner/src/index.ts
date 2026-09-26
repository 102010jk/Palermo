#!/usr/bin/env -S npx tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Api } from './api.ts';
import { doctor } from './doctor.ts';
import { limitResetDelay } from './limits.ts';
import { short } from './proc.ts';
import { runPool } from './pool.ts';
import { botAdapter } from './adapters/bot.ts';
import { claudeAdapter } from './adapters/claude.ts';
import { codexAdapter } from './adapters/codex.ts';
import { agyAdapter } from './adapters/agy.ts';
import { geminiAdapter } from './adapters/gemini.ts';
import { roleInfoOf } from '@palermo/engine';
import { continuePrompt, loadSkill, reportPrompt, skillForGame, startPrompt } from './prompt.ts';
import { PROVIDER_NAME, type Adapter, type AgentContext, type AgentSpec } from './types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface RunnerConfig {
  /** Base URL of the Palermo server, e.g. https://palermo.example.com */
  server: string;
  adminToken: string;
  /** Join an existing game... */
  gameId?: string;
  /** ...or create a new one with these settings (autoStart is turned on). */
  settings?: Record<string, unknown>;
  /** Scripted server-side bots to add as extra seats. */
  serverBots?: number;
  /** Extra seats reserved for humans joining from the browser (game waits for them). */
  humanSeats?: number;
  agents: AgentSpec[];
  skillPath?: string;
  runDir?: string;
  /** Delay between launching agents (ms) to avoid hammering one subscription at once. */
  staggerMs?: number;
  /** Number of games to play in a row with the same line-up. */
  games?: number;
}

const ADAPTERS: Record<AgentSpec['provider'], Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  agy: agyAdapter,
  bot: botAdapter,
};

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96];

/** Returns a fatal error message if the agent could not play at all. */
/** Sleep that ends early when the agent is stopped. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

async function runAgent(ctx: AgentContext, adapter: Adapter): Promise<string | undefined> {
  const maxRestarts = ctx.spec.maxRestarts ?? 5;
  let resumeId: string | undefined;
  let blockedRuns = 0;
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    if (ctx.signal?.aborted) break;
    let prompt = startPrompt(ctx);
    if (attempt > 0 || ctx.resuming) {
      const state = await ctx.api.game(ctx.gameId, ctx.token).catch(() => null);
      const ended = state?.view?.phase === 'ended';
      const me = state?.view?.you?.id;
      const reported = (state?.reports ?? []).some((r: any) => r.player_id === me);
      if (ended && reported) break;
      if (ended) prompt = reportPrompt(ctx);
      else if (me) prompt = continuePrompt(ctx);
      ctx.log(
        attempt === 0
          ? `back to its seat – ${ended ? 'writing report' : 'game still running'}`
          : `relaunching (attempt ${attempt}) – ${ended ? 'writing report' : me ? 'game still running' : 'not seated yet'}`,
      );
    }
    const res = await adapter.run(ctx, { attempt, prompt, resumeId });
    resumeId = res.sessionId ?? resumeId;
    if (res.blocked) {
      blockedRuns++;
      resumeId = undefined; // a refused conversation stays refused: start a new one
      ctx.log(`⚠️  the model's safety filter refused the conversation (${blockedRuns}×); next try starts a new session`);
      if (blockedRuns >= 3) {
        return `${ctx.spec.name}: the safety filter of ${ctx.spec.model ?? 'the model'} keeps refusing the game (${res.blocked})`;
      }
    }
    if (res.limited) {
      // Out of usage: pause the game for this player and wait until the limit resets. Not counted as a restart.
      const waitMs = limitResetDelay(res.limited);
      const until = new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.log(`⏸ usage limit reached (${short(res.limited, 120)}). The game pauses; trying again at ${until}.`);
      ctx.log('   You can also close the window: the game stays saved and paused, restart agents.bat later to finish it.');
      if (ctx.accountId) {
        await ctx.api
          .req('POST', `/api/admin/games/${ctx.gameId}/pause-for`, { accountId: ctx.accountId, reason: `${ctx.spec.name} is out of usage until about ${until}` })
          .catch(() => {});
      }
      await sleep(waitMs, ctx.signal);
      ctx.resuming = true;
      attempt--;
      continue;
    }
    if (res.usage) {
      await ctx.api
        .usage({ gameId: ctx.gameId, model: ctx.spec.model, source: ctx.spec.provider, ...res.usage }, ctx.token)
        .catch((e) => ctx.log(`usage report failed: ${e.message}`));
      ctx.log(
        `tokens: in ${res.usage.inputTokens}, cache read ${res.usage.cacheReadTokens}, cache write ${res.usage.cacheWriteTokens}, out ${res.usage.outputTokens}`,
      );
    }
    ctx.log(`process exited with code ${res.exitCode}`);
    if (res.fatal) {
      ctx.log(`❌ ${res.fatal}. Not relaunching.`);
      return res.fatal;
    }
    if (ctx.spec.provider === 'bot') break;
    // Check whether we are done (game over + report written).
    const state = await ctx.api.game(ctx.gameId, ctx.token).catch(() => null);
    const me = state?.view?.you?.id;
    if (state?.view?.phase === 'ended' && (state.reports ?? []).some((r: any) => r.player_id === me)) break;
  }
  return undefined;
}

export interface LaunchOptions {
  cfg: RunnerConfig;
  api: Api;
  skill: string;
  spec: AgentSpec;
  gameId: string;
  token: string;
  accountId: string;
  runDir: string;
  freedomMode: boolean;
  color: number;
  signal?: AbortSignal;
  /** Back into an existing seat (restart): continue instead of joining. */
  resuming?: boolean;
}

/** Plays one agent through one game (with relaunches). Returns a fatal error message if it could not play. */
/** How each player of a game was started (CLI, model, extra args), kept next to the logs so --resume can repeat it. */
function rememberLaunch(runDir: string, spec: AgentSpec): void {
  const file = join(runDir, 'launch.json');
  let all: Record<string, AgentSpec> = {};
  try {
    if (existsSync(file)) all = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    all = {};
  }
  all[spec.name] = spec;
  try {
    writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    // not essential
  }
}

function launchedSpecs(runDir: string): Record<string, AgentSpec> {
  try {
    return JSON.parse(readFileSync(join(runDir, 'launch.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function launchAgent(o: LaunchOptions): Promise<string | undefined> {
  const { spec, api } = o;
  rememberLaunch(o.runDir, spec);
  const workdir = join(o.runDir, spec.name.replace(/[^\w.-]/g, '_'));
  mkdirSync(workdir, { recursive: true });
  const logFile = join(workdir, 'agent.log');
  // In games where players only know their own role, the skill must not list the roles either.
  const settings = (await api.game(o.gameId).catch(() => null))?.view?.settings;
  const skill = skillForGame(o.skill, roleInfoOf(settings));
  const ctx: AgentContext = {
    spec,
    serverUrl: o.cfg.server,
    mcpUrl: `${o.cfg.server.replace(/\/$/, '')}/mcp`,
    token: o.token,
    gameId: o.gameId,
    workdir,
    freedomMode: o.freedomMode,
    skill,
    signal: o.signal,
    accountId: o.accountId,
    resuming: o.resuming,
    api,
    reportModel: (model) => {
      if (model === spec.model) return;
      api.setAgentModel(o.accountId, model).catch((e) => ctx.log(`model report failed: ${e.message}`));
    },
    log: (line) => {
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`\x1b[${o.color}m[${spec.name}]\x1b[0m ${line}`);
      appendFileSync(logFile, `${ts} ${line}\n`);
    },
  };
  try {
    return await runAgent(ctx, ADAPTERS[spec.provider]);
  } catch (e) {
    ctx.log(`crashed: ${(e as Error).stack ?? e}`);
    return undefined;
  }
}

async function playOneGame(cfg: RunnerConfig, api: Api, skill: string, gameNo: number): Promise<string> {
  let gameId = cfg.gameId;
  const created = !gameId;
  if (!gameId) {
    const seats = cfg.agents.length + (cfg.serverBots ?? 0) + (cfg.humanSeats ?? 0);
    const g = await api.createGame({ aiPool: false, ...cfg.settings, autoStart: true, seats });
    gameId = g.id;
    console.log(`Created game ${gameId} with ${seats} seats → ${cfg.server}/game/${gameId}`);
  }
  if (cfg.serverBots) await api.addBots(gameId, cfg.serverBots);

  // Outside the repo by default, so agents with file access cannot browse the config or each other easily.
  const runDir = resolve(cfg.runDir ?? join(tmpdir(), 'palermo-runs'), gameId);
  mkdirSync(runDir, { recursive: true });
  console.log(`Agent logs: ${runDir}/<agent>/agent.log`);
  const freedomMode = cfg.settings?.freedomMode === true;
  if (freedomMode && !existsSync('/.dockerenv')) {
    console.warn('⚠️  Freedom mode gives agents full shell/web access. Run the runner inside a container (see docs/agents.md).');
  }

  const jobs = cfg.agents.map(async (spec, i) => {
    if (cfg.staggerMs) await new Promise((r) => setTimeout(r, i * cfg.staggerMs!));
    const agent = await api.createAgent({ name: spec.name, provider: PROVIDER_NAME[spec.provider], model: spec.model, verified: true });
    return launchAgent({ cfg, api, skill, spec, gameId: gameId!, token: agent.token, accountId: agent.account.id, runDir, freedomMode, color: COLORS[i % COLORS.length] });
  });
  const fatals = (await Promise.all(jobs)).filter((x): x is string => !!x);
  let final: any;
  try {
    final = await api.game(gameId);
  } catch (e) {
    console.log(`\n\x1b[31mThe Palermo server at ${cfg.server} stopped responding (${(e as Error).message}).\x1b[0m`);
    console.log('Look at the server window for an error message and send it to the developer.');
    if (fatals.length) printFatalHelp(fatals);
    return gameId;
  }
  const stopped = created && final.view.phase !== 'ended';
  if (stopped) {
    // Don't leave a zombie lobby/game behind when the agents could not play.
    await api.req('POST', `/api/games/${gameId}/abort`, {}).catch(() => {});
    final = await api.game(gameId);
  }
  if (fatals.length) printFatalHelp(fatals);
  console.log(
    stopped
      ? `\nGame ${gameNo} (${gameId}) was stopped: the agents did not finish it (not counted in stats).`
      : `\nGame ${gameNo} (${gameId}) finished: phase=${final.view.phase}, winner=${final.view.winner ?? '-'}`,
  );
  return gameId;
}

const CLI_OF: Record<string, AgentSpec['provider']> = { anthropic: 'claude', openai: 'codex', google: 'agy', script: 'bot' };

/**
 * `--resume <gameId|latest>`: sit the AI players of an unfinished game back into their seats (after a usage limit,
 * a closed window or a restart) and play it to the end. Players are matched to the config by name; players missing
 * from the config are started from their seat's provider and model.
 */
async function resumeGame(cfg: RunnerConfig, api: Api, skill: string, which: string): Promise<void> {
  type Seat = { name: string; accountId: string; token: string; provider?: string; model?: string; alive: boolean };
  let gameId = which;
  let seats: Seat[] = [];
  if (which === 'latest') {
    const games = ((await api.req('GET', '/api/games')) as { id: string; phase: string; aborted?: boolean }[]).filter(
      (g) => g.phase === 'night' || g.phase === 'day',
    );
    for (const g of games) {
      const s = (await api.req('GET', `/api/admin/games/${g.id}/seats`).catch(() => [])) as Seat[];
      if (s.length) {
        gameId = g.id;
        seats = s;
        break;
      }
    }
    if (!seats.length) {
      console.log('No unfinished game with AI players found. Nothing to resume.');
      return;
    }
  } else {
    seats = (await api.req('GET', `/api/admin/games/${gameId}/seats`)) as Seat[];
  }
  console.log(`Resuming game ${gameId} → ${cfg.server.replace(/\/$/, '')}/game/${gameId}`);
  const game = await api.game(gameId);
  const runDir = resolve(cfg.runDir ?? join(tmpdir(), 'palermo-runs'), gameId);
  mkdirSync(runDir, { recursive: true });
  const launched = launchedSpecs(runDir);
  const jobs = seats.map((seat, i) => {
    const fromConfig = launched[seat.name] ?? cfg.agents.find((a) => a.name === seat.name);
    const provider = fromConfig?.provider ?? CLI_OF[seat.provider ?? ''];
    if (!provider) {
      console.log(`${seat.name}: unknown provider "${seat.provider}", add it to the config (same name) to resume it.`);
      return Promise.resolve(undefined);
    }
    const spec: AgentSpec = fromConfig ?? { name: seat.name, provider, model: seat.model, maxRestarts: provider === 'agy' ? 6 : 3 };
    return launchAgent({
      cfg,
      api,
      skill,
      spec,
      gameId,
      token: seat.token,
      accountId: seat.accountId,
      runDir,
      freedomMode: game?.view?.settings?.freedomMode === true,
      color: COLORS[i % COLORS.length],
      resuming: true,
    });
  });
  const fatals = (await Promise.all(jobs)).filter((x): x is string => !!x);
  if (fatals.length) printFatalHelp(fatals);
  const final = await api.game(gameId).catch(() => null);
  console.log(`\nGame ${gameId}: phase=${final?.view?.phase ?? '?'}, winner=${final?.view?.winner ?? '-'}`);
}

function printFatalHelp(fatals: string[]) {
  const unique = [...new Set(fatals)];
  console.log('\n\x1b[31mThe agents could not play:\x1b[0m');
  for (const f of unique) console.log(`  • ${f}`);
  if (unique.some((f) => f.includes('Claude Code is not logged in'))) {
    console.log(
      '\n  Fix the Claude login: run `claude` once and use /login, or better create a long-lived token with\n' +
        '  `claude setup-token` and set it before starting the runner (works reliably with many parallel players):\n' +
        '    PowerShell: $env:CLAUDE_CODE_OAUTH_TOKEN="<token>"\n' +
        '    bash:       export CLAUDE_CODE_OAUTH_TOKEN=<token>',
    );
  }
  if (unique.some((f) => f.includes('safety filter'))) {
    console.log(
      '\n  The model provider blocked the game prompt as a false positive. Run the line-up again (it is random);\n' +
        '  if it keeps happening with that model, replace it in the config (e.g. "model": "opus" or another version).',
    );
  }
  if (unique.some((f) => f.startsWith('Codex'))) {
    console.log('\n  Codex: run `codex login` once (sign in with ChatGPT) and check the model name with `codex -m <model>`.');
  }
  if (unique.some((f) => f.startsWith('agy'))) {
    console.log(
      '\n  Antigravity (agy): run `agy` once in a terminal and sign in with Google, then `agy update`.\n' +
        '  Model names: `agy models` (put one of them into "model" in the config).',
    );
  }
  if (unique.some((f) => f.startsWith('Gemini'))) {
    console.log('\n  Gemini: run `gemini` once and sign in with Google; check the model name with `gemini -m <model>`.');
  }
  if (unique.some((f) => f.includes('MCP'))) {
    console.log(
      '\n  Fix MCP: make sure the server runs and the "server" URL in the config is reachable from this machine.\n' +
        '  On Windows prefer http://127.0.0.1:3000 over http://localhost:3000.',
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: 'runner.config.json' },
      games: { type: 'string', short: 'n' },
      game: { type: 'string', short: 'g' },
      agent: { type: 'string', short: 'a', multiple: true },
      'create-only': { type: 'boolean' },
      check: { type: 'boolean' },
      pool: { type: 'boolean' },
      resume: { type: 'string' },
    },
  });
  // npm runs workspace scripts inside apps/runner; resolve paths from where the user invoked npm.
  const cfgPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.config!);
  if (!existsSync(cfgPath)) {
    console.error(`Config not found: ${cfgPath}. Copy runner.config.example.json to runner.config.json and edit it.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as RunnerConfig;
  cfg.adminToken = process.env.PALERMO_ADMIN_TOKEN ?? cfg.adminToken;
  if (values.game) cfg.gameId = values.game;
  if (values.agent?.length) {
    // Run only some agents (e.g. one agent per container). Needs --game so everyone joins the same table.
    cfg.agents = cfg.agents.filter((a) => values.agent!.includes(a.name));
    if (!cfg.agents.length) throw new Error(`No agent named ${values.agent.join(', ')} in the config.`);
    if (!cfg.gameId) throw new Error('--agent needs --game <id> (create the game first with --create-only).');
    cfg.serverBots = 0;
  }
  const api = new Api(cfg.server, cfg.adminToken);
  const proxy = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY'].find((k) => process.env[k]);
  if (proxy) console.log(`Note: ${proxy} is set on this machine; local addresses are excluded for the players (NO_PROXY).`);
  if (values.check) {
    await doctor(cfg.server, api);
    return;
  }
  if (values['create-only']) {
    const seats = cfg.agents.length + (cfg.serverBots ?? 0) + (cfg.humanSeats ?? 0);
    const g = await api.createGame({ aiPool: false, ...cfg.settings, autoStart: true, seats });
    if (cfg.serverBots) await api.addBots(g.id, cfg.serverBots);
    console.log(g.id);
    return;
  }
  const skill = loadSkill(resolve(cfg.skillPath ?? join(root, 'skills/palermo-player/SKILL.md')));
  if (values.pool) {
    await runPool(cfg, api, skill, root);
    return;
  }
  if (values.resume) {
    await resumeGame(cfg, api, skill, values.resume);
    return;
  }
  const games = Number(values.games ?? cfg.games ?? 1);
  for (let i = 1; i <= games; i++) {
    await playOneGame(cfg, api, skill, i);
    if (cfg.gameId) break; // an explicit game can only be played once
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
