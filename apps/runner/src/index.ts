#!/usr/bin/env -S npx tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Api } from './api.ts';
import { botAdapter } from './adapters/bot.ts';
import { claudeAdapter } from './adapters/claude.ts';
import { codexAdapter } from './adapters/codex.ts';
import { geminiAdapter } from './adapters/gemini.ts';
import { continuePrompt, loadSkill, reportPrompt, startPrompt } from './prompt.ts';
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
  bot: botAdapter,
};

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96];

async function runAgent(ctx: AgentContext, adapter: Adapter): Promise<void> {
  const maxRestarts = ctx.spec.maxRestarts ?? 5;
  let resumeId: string | undefined;
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    let prompt = startPrompt(ctx);
    if (attempt > 0) {
      const state = await ctx.api.game(ctx.gameId, ctx.token).catch(() => null);
      const ended = state?.view?.phase === 'ended';
      const me = state?.view?.you?.id;
      const reported = (state?.reports ?? []).some((r: any) => r.player_id === me);
      if (ended && reported) break;
      if (ended) prompt = reportPrompt(ctx);
      else prompt = continuePrompt(ctx);
      ctx.log(`relaunching (attempt ${attempt}) – ${ended ? 'writing report' : 'game still running'}`);
    }
    const res = await adapter.run(ctx, { attempt, prompt, resumeId });
    resumeId = res.sessionId ?? resumeId;
    if (res.usage) {
      await ctx.api
        .usage({ gameId: ctx.gameId, model: ctx.spec.model, source: ctx.spec.provider, ...res.usage }, ctx.token)
        .catch((e) => ctx.log(`usage report failed: ${e.message}`));
      ctx.log(
        `tokens: in ${res.usage.inputTokens}, cache read ${res.usage.cacheReadTokens}, cache write ${res.usage.cacheWriteTokens}, out ${res.usage.outputTokens}`,
      );
    }
    ctx.log(`process exited with code ${res.exitCode}`);
    if (ctx.spec.provider === 'bot') break;
    // Check whether we are done (game over + report written).
    const state = await ctx.api.game(ctx.gameId, ctx.token).catch(() => null);
    const me = state?.view?.you?.id;
    if (state?.view?.phase === 'ended' && (state.reports ?? []).some((r: any) => r.player_id === me)) break;
  }
}

async function playOneGame(cfg: RunnerConfig, api: Api, skill: string, gameNo: number): Promise<string> {
  let gameId = cfg.gameId;
  if (!gameId) {
    const seats = cfg.agents.length + (cfg.serverBots ?? 0) + (cfg.humanSeats ?? 0);
    const g = await api.createGame({ ...cfg.settings, autoStart: true, seats });
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
    const workdir = join(runDir, spec.name.replace(/[^\w.-]/g, '_'));
    mkdirSync(workdir, { recursive: true });
    const logFile = join(workdir, 'agent.log');
    const color = COLORS[i % COLORS.length];
    const ctx: AgentContext = {
      spec,
      serverUrl: cfg.server,
      mcpUrl: `${cfg.server.replace(/\/$/, '')}/mcp`,
      token: agent.token,
      gameId: gameId!,
      workdir,
      freedomMode,
      skill,
      api,
      log: (line) => {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`\x1b[${color}m[${spec.name}]\x1b[0m ${line}`);
        appendFileSync(logFile, `${ts} ${line}\n`);
      },
    };
    try {
      await runAgent(ctx, ADAPTERS[spec.provider]);
    } catch (e) {
      ctx.log(`crashed: ${(e as Error).stack ?? e}`);
    }
  });
  await Promise.all(jobs);
  const final = await api.game(gameId);
  console.log(`\nGame ${gameNo} (${gameId}) finished: phase=${final.view.phase}, winner=${final.view.winner ?? '-'}`);
  return gameId;
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: 'runner.config.json' },
      games: { type: 'string', short: 'n' },
      game: { type: 'string', short: 'g' },
      agent: { type: 'string', short: 'a', multiple: true },
      'create-only': { type: 'boolean' },
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
  if (values['create-only']) {
    const seats = cfg.agents.length + (cfg.serverBots ?? 0) + (cfg.humanSeats ?? 0);
    const g = await api.createGame({ ...cfg.settings, autoStart: true, seats });
    if (cfg.serverBots) await api.addBots(g.id, cfg.serverBots);
    console.log(g.id);
    return;
  }
  const skill = loadSkill(resolve(cfg.skillPath ?? join(root, 'skills/palermo-player/SKILL.md')));
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
