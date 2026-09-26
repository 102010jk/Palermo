import crossSpawn from 'cross-spawn';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPipeFor } from '../pipe.ts';
import { runProcess, short, tryJson } from '../proc.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-bridge.mjs');

/** The palermo tools; used to recognise them whatever prefix agy puts in front of MCP tool names. */
const PALERMO_TOOLS =
  /\b(login|list_games|join_game|set_ready|leave_game|wait_for_events|get_state|get_history|say|vote|night_action|get_notes|save_notes|submit_report)\b/;

/** agy's own tool-call timeout for MCP servers is not configurable; keep each long-poll well below it. */
const MAX_WAIT_SEC = 55;

/** agy keeps the process alive after the final answer on some versions (issue #947): stop it ourselves. */
const EXIT_GRACE_MS = 20000;

const AUTH_ERROR = /authentication required|not (signed|logged) in|sign in|unauthori[sz]ed|login required|credentials/i;
const MODEL_ERROR = /unknown model|model .*(not (found|supported|available))|invalid model/i;
const PERMISSION_DENIED = /permission|not allowed|denied|requires approval|allow rule/i;

const USER_SETTINGS = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

let allowRuleChecked = false;

/**
 * Headless agy auto-denies MCP tools that need approval, and permission rules live only in the user's settings file.
 * Adds (once) the rule `mcp(palermo/*)`, which allows only the palermo game tools and nothing else.
 */
function ensureAllowRule(ctx: AgentContext): void {
  if (allowRuleChecked) return;
  allowRuleChecked = true;
  const rule = 'mcp(palermo/*)';
  let settings: any = {};
  if (existsSync(USER_SETTINGS)) {
    settings = tryJson(readFileSync(USER_SETTINGS, 'utf8'));
    if (!settings || typeof settings !== 'object') {
      ctx.log(`⚠️  could not parse ${USER_SETTINGS}; add "${rule}" to permissions.allow there yourself`);
      return;
    }
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (settings.permissions.allow.includes(rule)) return;
  settings.permissions.allow.push(rule);
  mkdirSync(dirname(USER_SETTINGS), { recursive: true });
  writeFileSync(USER_SETTINGS, JSON.stringify(settings, null, 2));
  ctx.log(`added permission rule ${rule} to ${USER_SETTINGS} (lets agy call the game tools without asking)`);
}

/** `agy models`, for the error message when the configured model name is wrong. */
function listModels(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = crossSpawn(cmd, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', () => resolve(''));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.replace(/\x1b\[[0-9;]*m/g, '').trim());
    });
  });
}

/**
 * Google Antigravity CLI (`agy -p`), signed in with your Google account (Google AI plan).
 * Skill in GEMINI.md, MCP server (the local stdio bridge) in .agents/mcp_config.json of the working directory,
 * stream-json output (init / step_update / result events), resume with --conversation <id>.
 */
export const agyAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    const cmd = ctx.spec.command ?? 'agy';
    const known = ctx.spec.model ? workingModelArgs.get(ctx.spec.model) : undefined;
    const variants = known ? [known] : modelVariants(ctx.spec.model);
    let res: AgyResult | undefined;
    for (const modelArgs of variants) {
      res = await runOnce(ctx, launch, cmd, modelArgs);
      if (!res.modelError) {
        if (ctx.spec.model) workingModelArgs.set(ctx.spec.model, modelArgs);
        return res;
      }
      if (variants.length > 1) ctx.log(`agy did not accept ${modelArgs.join(' ')}; trying the next form`);
    }
    const models = await listModels(cmd);
    return {
      ...res!,
      fatal:
        `agy rejected the model "${ctx.spec.model}". Use a name from \`agy models\`` +
        (models ? `:\n${models.split(/\r?\n/).map((l) => `      ${l}`).join('\n')}` : ''),
    };
  },
};

/** Model selections that worked, per configured model name. */
const workingModelArgs = new Map<string, string[]>();

/**
 * agy lists models as "gemini-3.8-flash-high", but some versions want the base name plus --effort
 * ("--model gemini-3.8-flash requires --effort"). Try the forms in turn.
 */
function modelVariants(model: string | undefined): string[][] {
  if (!model) return [[]];
  const m = /^(.*)-(low|medium|high)$/.exec(model);
  if (m) return [['--model', model], ['--model', m[1], '--effort', m[2]], ['--model', model, '--effort', m[2]]];
  return [['--model', model], ['--model', model, '--effort', 'high'], ['--model', `${model}-high`]];
}

type AgyResult = RunResult & { modelError?: boolean };

async function runOnce(ctx: AgentContext, launch: Launch, cmd: string, modelArgs: string[]): Promise<AgyResult> {
  writeFileSync(join(ctx.workdir, 'GEMINI.md'), ctx.skill);
  mkdirSync(join(ctx.workdir, '.agents'), { recursive: true });
  const pipe = localPipeFor(ctx.mcpUrl);
  const mcpConfig = {
    mcpServers: {
      palermo: {
        command: process.execPath,
        args: [BRIDGE, ctx.mcpUrl],
        env: {
          PALERMO_TOKEN: ctx.token,
          PALERMO_BRIDGE_LOG: join(ctx.workdir, 'bridge.log'),
          PALERMO_MAX_WAIT: String(MAX_WAIT_SEC),
          ...(pipe ? { PALERMO_SOCKET: pipe } : {}),
        },
      },
    },
  };
  writeFileSync(join(ctx.workdir, '.agents', 'mcp_config.json'), JSON.stringify(mcpConfig, null, 2));
  // Freedom mode approves everything anyway; rules mode allows only the game tools (shell commands stay denied).
  if (!ctx.freedomMode) ensureAllowRule(ctx);

  const args = ['-p', launch.prompt.replace(/\s*\n\s*/g, ' '), '--output-format', 'stream-json'];
  args.push(...modelArgs);
  if (launch.resumeId) args.push('--conversation', launch.resumeId);
  if (ctx.freedomMode) args.push('--dangerously-skip-permissions');
  args.push(...(ctx.spec.extraArgs ?? []));

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: null };
  let fatal: string | undefined;
  let sid: string | undefined;
  let said = '';
  let palermoLoaded: boolean | undefined;
  let palermoCalls = 0;
  let deniedTool: string | undefined;
  let modelError = false;
  let spawnFailed = false;
  let kill: (() => void) | undefined;
  let exitTimer: NodeJS.Timeout | undefined;
  const seenTools = new Set<number>();
  const flush = () => {
    if (said.trim()) ctx.log(`💬 ${short(said)}`);
    said = '';
  };
  const checkError = (text: string) => {
    if (AUTH_ERROR.test(text)) fatal = 'agy is not signed in (run `agy` once and sign in with Google)';
    else if (MODEL_ERROR.test(text)) modelError = true;
  };

  const started = Date.now();
  const code = await runProcess(cmd, args, {
    cwd: ctx.workdir,
    signal: ctx.signal,
    env: { AGY_CLI_HIDE_LOGO: '1' },
    onKill: (k) => (kill = k),
    onErr: (l) => {
      ctx.log(`stderr: ${short(l)}`);
      if (l.startsWith('spawn failed')) spawnFailed = true;
      checkError(l);
      if (/mcp\(|palermo/i.test(l) && PERMISSION_DENIED.test(l)) deniedTool ??= short(l, 200);
    },
    onLine: (line) => {
      const m = tryJson(line);
      if (!m) return ctx.log(short(line));
      if (m.event === 'init') {
        sid = m.conversation_id ?? sid;
        const init = m.init ?? {};
        const tools: string[] = Array.isArray(init.tools) ? init.tools.map(String) : [];
        palermoLoaded = tools.some((t) => /palermo/i.test(t) || /wait_for_events/.test(t));
        ctx.log(`conversation ${sid}, model ${init.model ?? '?'}, permissions ${init.permission_mode ?? '?'}, ${tools.length} tools`);
        if (!palermoLoaded && tools.length) ctx.log(`⚠️  no palermo tools among: ${short(tools.join(', '), 300)}`);
        if (init.model) ctx.reportModel(String(init.model));
        else if (ctx.spec.model) ctx.reportModel(ctx.spec.model);
      } else if (m.event === 'step_update') {
        const s = m.step_update ?? {};
        if (s.step_type === 'agent_response') {
          said += String(s.text_delta ?? '');
          if (s.state === 'DONE') flush();
        } else if (s.step_type === 'tool') {
          const info = s.tool_info ?? {};
          const name = String(info.name ?? s.tool_name ?? '');
          const isGame = PALERMO_TOOLS.test(name) || /palermo/i.test(name);
          if (!seenTools.has(s.step_index)) {
            seenTools.add(s.step_index);
            flush();
            ctx.log(`🔧 ${name.replace(/^.*[/_]palermo[/_]+|^palermo[/_]+/, '')} ${short(JSON.stringify(info.parameters ?? {}), 200)}`);
          }
          if (s.state === 'DONE') {
            if (info.error) {
              const text = `${info.error.type ?? ''} ${info.error.message ?? ''}`;
              ctx.log(`tool failed: ${short(text, 300)}`);
              if (isGame && PERMISSION_DENIED.test(text)) deniedTool ??= `${name}: ${short(text, 200)}`;
            } else if (isGame) {
              palermoCalls++;
            }
          }
        }
      } else if (m.event === 'result') {
        flush();
        const r = m.result ?? {};
        sid = r.conversation_id ?? sid;
        // Usage is cumulative for the process; keep the latest.
        const u = r.usage ?? {};
        usage.cacheReadTokens = u.cache_read_tokens ?? 0;
        usage.inputTokens = Math.max(0, (u.input_tokens ?? 0) - usage.cacheReadTokens);
        usage.outputTokens = (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
        ctx.log(`result: ${r.status ?? '?'} after ${r.num_turns ?? '?'} turns${r.error ? ` – ${short(String(r.error), 300)}` : ''}`);
        if (r.error) checkError(String(r.error));
        if (!exitTimer) exitTimer = setTimeout(() => kill?.(), EXIT_GRACE_MS);
      }
    },
  });
  if (exitTimer) clearTimeout(exitTimer);
  flush();
  usage.durationMs = Date.now() - started;

  if (!fatal && deniedTool && palermoCalls === 0) {
    fatal =
      `agy blocked the palermo game tools (${deniedTool}). Update agy (\`agy update\`), check that ${USER_SETTINGS} ` +
      'has "mcp(palermo/*)" in permissions.allow, or as a last resort add "extraArgs": ["--dangerously-skip-permissions"] to this player';
  }
  if (!fatal && palermoLoaded === false && palermoCalls === 0) {
    fatal = `agy did not load the palermo MCP server from ${join(ctx.workdir, '.agents', 'mcp_config.json')} (see bridge.log next to it)`;
  }
  if (!fatal && spawnFailed) fatal = `agy could not be started ("${cmd}") – is the Antigravity CLI installed and on PATH?`;
  return { exitCode: code, sessionId: sid, usage, fatal, modelError: !fatal && modelError && palermoCalls === 0 };
}
