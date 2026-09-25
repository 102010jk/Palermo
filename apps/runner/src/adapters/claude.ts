import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPipeFor } from '../pipe.ts';
import { runProcess, short, tryJson } from '../proc.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

/**
 * If the runner itself is started from inside a Claude Code session (e.g. its terminal), these variables would
 * make every player join that parent session. Players must be independent sessions.
 */
const PARENT_SESSION_ENV: Record<string, undefined> = Object.fromEntries(
  [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_REMOTE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SYNC_SESSION_REFS',
    'CLAUDE_CODE_TEE_SDK_STDOUT',
    'CLAUDE_CODE_DIAGNOSTICS_FILE',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_PID',
  ].map((k) => [k, undefined]),
);

/**
 * Claude Code in headless mode (`claude -p`), one long session per game.
 * Rules mode: built-in tools disabled, custom short system prompt (fewer tokens), only palermo MCP tools.
 * Freedom mode: default Claude Code prompt + all tools, permissions bypassed. Only run this inside a container.
 */
/** The interesting lines about the palermo MCP connection from a Claude Code debug log, de-duplicated. */
function mcpErrors(path: string): string[] {
  if (!existsSync(path)) return [`(no debug log at ${path})`];
  const seen = new Set<string>();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!raw.includes('MCP server "palermo"')) continue;
    if (!/error|fail|refused|timeout|proxy|status|certificate|denied|unauthori|40\d|50\d/i.test(raw)) continue;
    seen.add(raw.replace(/^\S+\s+/, '').slice(0, 400));
    if (seen.size >= 10) break;
  }
  return seen.size ? [...seen] : [`(nothing about palermo in ${path})`];
}

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-bridge.mjs');

const AUTH_ERROR = /authenticat|oauth|invalid api key|\/login|not logged in|credit balance/i;

export const claudeAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    const mcpPath = join(ctx.workdir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            palermo:
              ctx.spec.mcpTransport === 'http'
                ? { type: 'http', url: ctx.mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` } }
                : // Default: local stdio bridge running in Node (robust against CLI HTTP-client quirks).
                  {
                    type: 'stdio',
                    command: process.execPath,
                    args: [BRIDGE, ctx.mcpUrl],
                    env: {
                      PALERMO_TOKEN: ctx.token,
                      PALERMO_BRIDGE_LOG: join(ctx.workdir, 'bridge.log'),
                      ...(localPipeFor(ctx.mcpUrl) ? { PALERMO_SOCKET: localPipeFor(ctx.mcpUrl) } : {}),
                    },
                  },
          },
        },
        null,
        2,
      ),
    );
    const promptPath = join(ctx.workdir, 'system-prompt.md');
    writeFileSync(promptPath, ctx.skill);

    const sessionId = launch.resumeId ?? randomUUID();
    const args = ['-p', launch.prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpPath, '--strict-mcp-config'];
    if (ctx.spec.model) args.push('--model', ctx.spec.model);
    if (launch.resumeId) args.push('--resume', launch.resumeId);
    else args.push('--session-id', sessionId);

    if (ctx.freedomMode) {
      args.push('--append-system-prompt-file', promptPath, '--permission-mode', 'bypassPermissions');
    } else {
      args.push('--system-prompt-file', promptPath, '--tools', '', '--allowedTools', 'mcp__palermo', '--permission-mode', 'dontAsk');
    }
    // Debug log: the only place where Claude Code says *why* an MCP connection failed.
    const debugPath = join(ctx.workdir, `claude-debug-${launch.attempt}.log`);
    args.push('--debug-file', debugPath);
    args.push(...(ctx.spec.extraArgs ?? []));

    let usage: Usage | undefined;
    let sid = sessionId;
    let fatal: string | undefined;
    const code = await runProcess(ctx.spec.command ?? 'claude', args, {
      cwd: ctx.workdir,
      env: { MCP_TOOL_TIMEOUT: '300000', MCP_TIMEOUT: '60000', ...PARENT_SESSION_ENV },
      onErr: (l) => ctx.log(`stderr: ${short(l)}`),
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'system' && m.subtype === 'init') {
          sid = m.session_id ?? sid;
          const srv = (m.mcp_servers ?? []).find((s: any) => s.name === 'palermo');
          ctx.log(`session ${sid}, model ${m.model ?? '?'}, palermo MCP: ${srv?.status ?? 'missing'}`);
          if (m.model) ctx.reportModel(String(m.model));
          if (srv?.status !== 'connected') {
            ctx.log(`MCP details: ${short(JSON.stringify(srv ?? {}), 300)}`);
            fatal = `Claude Code could not connect to the palermo MCP server at ${ctx.mcpUrl}`;
          }
        } else if (m.type === 'assistant') {
          for (const c of m.message?.content ?? []) {
            if (c.type === 'text' && c.text?.trim()) {
              ctx.log(`💬 ${short(c.text)}`);
              if (AUTH_ERROR.test(c.text)) fatal = `Claude Code is not logged in: ${short(c.text, 120)}`;
            }
            if (c.type === 'tool_use') ctx.log(`🔧 ${String(c.name).replace('mcp__palermo__', '')} ${short(JSON.stringify(c.input ?? {}), 200)}`);
          }
        } else if (m.type === 'result') {
          const u = m.usage ?? {};
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            costUsd: m.total_cost_usd ?? null,
            durationMs: m.duration_ms ?? null,
          };
          ctx.log(`result: ${m.subtype}, turns ${m.num_turns ?? '?'}, cost ~$${(m.total_cost_usd ?? 0).toFixed(3)} (API-equivalent)`);
        }
      },
    });
    if (fatal?.includes('MCP')) {
      for (const line of mcpErrors(debugPath)) ctx.log(`MCP debug: ${line}`);
      const bridgeLog = join(ctx.workdir, 'bridge.log');
      if (existsSync(bridgeLog)) {
        for (const line of readFileSync(bridgeLog, 'utf8').trim().split(/\r?\n/).slice(-6)) ctx.log(`bridge: ${line}`);
      }
    }
    return { exitCode: code, sessionId: sid, usage, fatal };
  },
};
