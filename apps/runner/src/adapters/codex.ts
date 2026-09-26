import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPipeFor } from '../pipe.ts';
import { runProcess, short, tryJson } from '../proc.ts';
import { isUsageLimit } from '../limits.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-bridge.mjs');

/** TOML basic string (JSON string escaping is valid TOML). */
const toml = (s: string) => JSON.stringify(s);

/** Built-in Codex capabilities switched off in rules mode, so the only way to act is the palermo MCP tools. */
const RULES_MODE_DISABLED_FEATURES = ['shell_tool', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'apps'];

/**
 * Players run with their own CODEX_HOME that holds only the login (auth.json): the user's plugins (Browser Use,
 * node_repl…), other MCP servers, memories and global AGENTS.md stay out of the game. The login is kept in sync
 * both ways, so a token refreshed by either side keeps working.
 */
const USER_CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const PLAYER_CODEX_HOME = join(homedir(), '.palermo', 'codex-home');

function newer(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (!existsSync(dst)) return true;
  return statSync(src).mtimeMs > statSync(dst).mtimeMs && readFileSync(src, 'utf8') !== readFileSync(dst, 'utf8');
}

/** Returns the CODEX_HOME for players, or undefined when the login is not in a file (then the user's home is used). */
function playerCodexHome(ctx: AgentContext): string | undefined {
  const userAuth = join(USER_CODEX_HOME, 'auth.json');
  if (!existsSync(userAuth)) {
    ctx.log(`note: ${userAuth} not found, using your normal Codex setup (plugins included)`);
    return undefined;
  }
  mkdirSync(PLAYER_CODEX_HOME, { recursive: true });
  const playerAuth = join(PLAYER_CODEX_HOME, 'auth.json');
  if (newer(userAuth, playerAuth)) copyFileSync(userAuth, playerAuth);
  return PLAYER_CODEX_HOME;
}

function syncLoginBack(home: string | undefined): void {
  if (!home) return;
  const playerAuth = join(home, 'auth.json');
  const userAuth = join(USER_CODEX_HOME, 'auth.json');
  try {
    if (newer(playerAuth, userAuth)) copyFileSync(playerAuth, userAuth);
  } catch {
    // the user's Codex keeps its own login; nothing to do
  }
}

const AUTH_ERROR = /401|unauthori[sz]ed|not logged in|codex login|missing bearer|invalid api key/i;

/**
 * OpenAI Codex CLI (`codex exec`), signed in with your ChatGPT subscription.
 * The palermo MCP server is the local stdio bridge (same as for Claude), configured with -c overrides so the
 * user's ~/.codex stays untouched. The skill goes into AGENTS.md, which Codex reads from the working directory.
 */
export const codexAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    writeFileSync(join(ctx.workdir, 'AGENTS.md'), ctx.skill);
    const pipe = localPipeFor(ctx.mcpUrl);
    const env = [
      `PALERMO_TOKEN=${toml(ctx.token)}`,
      `PALERMO_BRIDGE_LOG=${toml(join(ctx.workdir, 'bridge.log'))}`,
      ...(pipe ? [`PALERMO_SOCKET=${toml(pipe)}`] : []),
    ];
    const opts = ['--json', '--skip-git-repo-check'];
    if (ctx.spec.model) opts.push('--model', ctx.spec.model);
    opts.push(
      '-c', `mcp_servers.palermo.command=${toml(process.execPath)}`,
      '-c', `mcp_servers.palermo.args=[${toml(BRIDGE)},${toml(ctx.mcpUrl)}]`,
      '-c', `mcp_servers.palermo.env={${env.join(',')}}`,
      '-c', 'mcp_servers.palermo.tool_timeout_sec=300',
      '-c', 'mcp_servers.palermo.startup_timeout_sec=60',
      // Without this, codex exec refuses every call to an unannotated MCP tool ("requires approval, but approval policy is never").
      '-c', 'mcp_servers.palermo.default_tools_approval_mode="approve"',
      '-c', 'approval_policy="never"',
    );
    if (ctx.freedomMode) {
      opts.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      opts.push('--sandbox', 'read-only', '-c', 'web_search="disabled"');
      for (const f of RULES_MODE_DISABLED_FEATURES) opts.push('--disable', f);
    }
    opts.push(...(ctx.spec.extraArgs ?? []));
    // npm installs codex as a .cmd shim on Windows; cmd.exe cannot pass multi-line arguments.
    const prompt = launch.prompt.replace(/\s*\n\s*/g, ' ');
    const args = launch.resumeId ? ['exec', ...opts, 'resume', launch.resumeId, prompt] : ['exec', ...opts, prompt];

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: null };
    let sid: string | undefined;
    let fatal: string | undefined;
    let limited: string | undefined;
    const home = playerCodexHome(ctx);
    const started = Date.now();
    const code = await runProcess(ctx.spec.command ?? 'codex', args, {
      cwd: ctx.workdir,
      signal: ctx.signal,
      env: home ? { CODEX_HOME: home } : {},
      onErr: (l) => {
        if (/WARNING: proceeding|Reading additional input/.test(l)) return;
        ctx.log(`stderr: ${short(l)}`);
        if (isUsageLimit(l)) limited = l.trim();
        else if (AUTH_ERROR.test(l)) fatal = 'Codex is not logged in (run `codex login` once)';
      },
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'thread.started') {
          sid = m.thread_id;
          if (ctx.spec.model) ctx.reportModel(ctx.spec.model);
        }
        const item = m.item ?? {};
        if (m.type === 'item.completed' && item.type === 'agent_message') ctx.log(`💬 ${short(item.text ?? '')}`);
        if (m.type === 'item.completed' && item.type === 'reasoning' && item.text) ctx.log(`🧠 ${short(item.text)}`);
        if (m.type === 'item.started' && item.type === 'mcp_tool_call') {
          ctx.log(`🔧 ${item.tool} ${short(JSON.stringify(item.arguments ?? {}), 200)}`);
        }
        if (m.type === 'item.completed' && item.type === 'mcp_tool_call' && item.status === 'failed') {
          const text = JSON.stringify(item.error ?? item.result ?? {});
          ctx.log(`tool failed: ${short(text, 300)}`);
          if (/requires approval/i.test(text) && item.server === 'palermo') {
            fatal = 'Codex refused the palermo tools ("requires approval"). Update Codex (npm install -g @openai/codex) and send the log';
          }
        }
        const u = m.usage;
        if (u && m.type === 'turn.completed') {
          usage.inputTokens += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
          usage.cacheReadTokens += u.cached_input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
        }
        if (m.type === 'error' || m.type === 'turn.failed') {
          const text = JSON.stringify(m);
          ctx.log(`error: ${short(text, 300)}`);
          if (isUsageLimit(text)) limited = String(m.message ?? m.error?.message ?? text);
          else if (AUTH_ERROR.test(text)) fatal = 'Codex is not logged in (run `codex login` once)';
          if (/model.*(not (found|supported|exist))|unknown model|does not exist/i.test(text)) {
            fatal = `Codex rejected the model "${ctx.spec.model}". Check the exact model name (codex -m ...)`;
          }
        }
      },
    });
    usage.durationMs = Date.now() - started;
    syncLoginBack(home);
    if (limited) fatal = undefined;
    return { exitCode: code, sessionId: sid, usage, fatal, limited };
  },
};
