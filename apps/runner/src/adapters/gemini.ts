import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPipeFor } from '../pipe.ts';
import { runProcess, short, tryJson } from '../proc.ts';
import { isUsageLimit } from '../limits.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-bridge.mjs');

/** Gemini CLI built-in tools removed in rules mode (files, shell, web): only the palermo MCP tools remain. */
const RULES_MODE_EXCLUDED_TOOLS = [
  'run_shell_command',
  'write_file',
  'replace',
  'read_file',
  'read_many_files',
  'glob',
  'grep_search',
  'list_directory',
  'web_fetch',
  'google_web_search',
  'save_memory',
  'invoke_agent',
  'activate_skill',
  'get_internal_docs',
  'write_todos',
  'take_snapshot',
];

const AUTH_ERROR = /api key|auth|login|credential|permission denied|unauthori[sz]ed|quota/i;

/**
 * Google Gemini CLI (`gemini -p`), signed in with your Google account.
 * Skill in GEMINI.md, MCP server (the local stdio bridge) in .gemini/settings.json of the working directory.
 * GEMINI_CLI_TRUST_WORKSPACE makes Gemini load that project config (it ignores it in "untrusted" folders).
 */
export const geminiAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    writeFileSync(join(ctx.workdir, 'GEMINI.md'), ctx.skill);
    mkdirSync(join(ctx.workdir, '.gemini'), { recursive: true });
    const pipe = localPipeFor(ctx.mcpUrl);
    const settings: Record<string, unknown> = {
      mcpServers: {
        palermo: {
          command: process.execPath,
          args: [BRIDGE, ctx.mcpUrl],
          env: {
            PALERMO_TOKEN: ctx.token,
            PALERMO_BRIDGE_LOG: join(ctx.workdir, 'bridge.log'),
            ...(pipe ? { PALERMO_SOCKET: pipe } : {}),
          },
          timeout: 300000,
          trust: true,
        },
      },
    };
    if (!ctx.freedomMode) settings.tools = { exclude: RULES_MODE_EXCLUDED_TOOLS };
    writeFileSync(join(ctx.workdir, '.gemini', 'settings.json'), JSON.stringify(settings, null, 2));

    // npm installs gemini as a .cmd shim on Windows; cmd.exe cannot pass multi-line arguments.
    const args = ['-p', launch.prompt.replace(/\s*\n\s*/g, ' '), '--output-format', 'stream-json', '--allowed-mcp-server-names', 'palermo', '--skip-trust'];
    if (ctx.spec.model) args.push('-m', ctx.spec.model);
    if (launch.resumeId) args.push('--resume', 'latest');
    if (ctx.freedomMode) args.push('--yolo');
    args.push(...(ctx.spec.extraArgs ?? []));

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: null };
    let fatal: string | undefined;
    let limited: string | undefined;
    let sid: string | undefined;
    let said = '';
    const flush = () => {
      if (said.trim()) ctx.log(`💬 ${short(said)}`);
      said = '';
    };
    const started = Date.now();
    const code = await runProcess(ctx.spec.command ?? 'gemini', args, {
      cwd: ctx.workdir,
      signal: ctx.signal,
      env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      onErr: (l) => {
        if (/256-color|Loaded cached credentials|deprecated and will be removed|^\s+at /.test(l)) return;
        ctx.log(`stderr: ${short(l)}`);
      },
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'init') {
          sid = m.session_id ?? sid;
          ctx.log(`session ${sid}, model ${m.model ?? '?'}`);
          if (m.model && m.model !== 'auto') ctx.reportModel(String(m.model));
          else if (ctx.spec.model) ctx.reportModel(ctx.spec.model);
        } else if (m.type === 'message' && m.role === 'assistant') {
          said += String(m.content ?? '');
          if (!m.delta) flush();
        } else if (m.type === 'tool_use') {
          flush();
          ctx.log(`🔧 ${String(m.tool_name ?? '').replace(/^palermo__|^mcp_palermo_/, '')} ${short(JSON.stringify(m.parameters ?? {}), 200)}`);
        } else if (m.type === 'tool_result' && m.status === 'error') {
          ctx.log(`tool failed: ${short(JSON.stringify(m.error ?? m.output ?? {}), 300)}`);
        } else if (m.type === 'error') {
          ctx.log(`error: ${short(JSON.stringify(m), 300)}`);
        } else if (m.type === 'result') {
          flush();
          const s = m.stats ?? {};
          usage.cacheReadTokens += s.cached ?? 0;
          usage.inputTokens += Math.max(0, (s.input_tokens ?? 0) - (s.cached ?? 0));
          usage.outputTokens += s.output_tokens ?? 0;
          if (m.status === 'error') {
            const text = JSON.stringify(m.error ?? {});
            ctx.log(`result: error ${short(text, 300)}`);
            if (isUsageLimit(text)) limited = text;
            else if (AUTH_ERROR.test(text)) fatal = `Gemini CLI cannot use the model: ${short(text, 160)} (run \`gemini\` once and sign in)`;
            else if (/model/i.test(text) && /not found|not supported|invalid/i.test(text)) {
              fatal = `Gemini rejected the model "${ctx.spec.model}". Check the exact model name (gemini -m ...)`;
            }
          }
        }
      },
    });
    flush();
    usage.durationMs = Date.now() - started;
    if (limited) fatal = undefined;
    return { exitCode: code, sessionId: sid, usage, fatal, limited };
  },
};
