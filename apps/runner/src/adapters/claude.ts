import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, short, tryJson } from '../proc.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

/**
 * Claude Code in headless mode (`claude -p`), one long session per game.
 * Rules mode: built-in tools disabled, custom short system prompt (fewer tokens), only palermo MCP tools.
 * Freedom mode: default Claude Code prompt + all tools, permissions bypassed. Only run this inside a container.
 */
export const claudeAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    const mcpPath = join(ctx.workdir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify(
        { mcpServers: { palermo: { type: 'http', url: ctx.mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` } } } },
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
    args.push(...(ctx.spec.extraArgs ?? []));

    let usage: Usage | undefined;
    let sid = sessionId;
    const code = await runProcess(ctx.spec.command ?? 'claude', args, {
      cwd: ctx.workdir,
      env: { MCP_TOOL_TIMEOUT: '300000', MCP_TIMEOUT: '60000' },
      onErr: (l) => ctx.log(`stderr: ${short(l)}`),
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'system' && m.subtype === 'init') {
          sid = m.session_id ?? sid;
          const srv = (m.mcp_servers ?? []).find((s: any) => s.name === 'palermo');
          ctx.log(`session ${sid}, model ${m.model ?? '?'}, palermo MCP: ${srv?.status ?? 'missing'}`);
        } else if (m.type === 'assistant') {
          for (const c of m.message?.content ?? []) {
            if (c.type === 'text' && c.text?.trim()) ctx.log(`💬 ${short(c.text)}`);
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
    return { exitCode: code, sessionId: sid, usage };
  },
};
