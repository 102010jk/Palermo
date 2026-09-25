import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, short, tryJson } from '../proc.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

/**
 * OpenAI Codex CLI (`codex exec`), signed in with your ChatGPT subscription.
 * The skill goes into AGENTS.md in the working directory (Codex reads it automatically).
 * The palermo MCP server is configured with -c overrides (Streamable HTTP + bearer token from env).
 */
export const codexAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    writeFileSync(join(ctx.workdir, 'AGENTS.md'), ctx.skill);
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (ctx.spec.model) args.push('--model', ctx.spec.model);
    args.push(
      '-c', `mcp_servers.palermo.url="${ctx.mcpUrl}"`,
      '-c', 'mcp_servers.palermo.bearer_token_env_var="PALERMO_TOKEN"',
      '-c', 'mcp_servers.palermo.tool_timeout_sec=300',
      '-c', 'approval_policy="never"',
    );
    if (ctx.freedomMode) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'read-only');
    args.push(...(ctx.spec.extraArgs ?? []), launch.prompt);

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: null };
    let sid: string | undefined;
    const started = Date.now();
    const code = await runProcess(ctx.spec.command ?? 'codex', args, {
      cwd: ctx.workdir,
      env: { PALERMO_TOKEN: ctx.token },
      onErr: (l) => ctx.log(`stderr: ${short(l)}`),
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'thread.started') sid = m.thread_id;
        const item = m.item ?? {};
        if (m.type === 'item.completed' && item.type === 'agent_message') ctx.log(`💬 ${short(item.text ?? '')}`);
        if (m.type === 'item.started' && item.type === 'mcp_tool_call') ctx.log(`🔧 ${item.tool} ${short(JSON.stringify(item.arguments ?? {}), 200)}`);
        const u = m.usage;
        if (u && m.type === 'turn.completed') {
          usage.inputTokens += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
          usage.cacheReadTokens += u.cached_input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
        }
        if (m.type === 'error' || m.type === 'turn.failed') ctx.log(`error: ${short(JSON.stringify(m))}`);
      },
    });
    usage.durationMs = Date.now() - started;
    return { exitCode: code, sessionId: sid, usage };
  },
};
