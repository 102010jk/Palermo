import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, short, tryJson } from '../proc.ts';
import type { Adapter, AgentContext, Launch, RunResult, Usage } from '../types.ts';

/**
 * Google Gemini CLI (`gemini -p`), signed in with your Google account.
 * The skill goes into GEMINI.md; the MCP server is configured in .gemini/settings.json of the workdir
 * and marked trusted so its tool calls need no confirmation. In non-interactive mode Gemini CLI does not
 * run tools that need confirmation (shell, file writes), which is what we want in rules mode.
 */
export const geminiAdapter: Adapter = {
  async run(ctx: AgentContext, launch: Launch): Promise<RunResult> {
    writeFileSync(join(ctx.workdir, 'GEMINI.md'), ctx.skill);
    mkdirSync(join(ctx.workdir, '.gemini'), { recursive: true });
    writeFileSync(
      join(ctx.workdir, '.gemini', 'settings.json'),
      JSON.stringify(
        {
          mcpServers: {
            palermo: { httpUrl: ctx.mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` }, timeout: 300000, trust: true },
          },
        },
        null,
        2,
      ),
    );
    const args = ['-p', launch.prompt, '--output-format', 'stream-json', '--allowed-mcp-server-names', 'palermo'];
    if (ctx.spec.model) args.push('-m', ctx.spec.model);
    if (ctx.freedomMode) args.push('--yolo');
    args.push(...(ctx.spec.extraArgs ?? []));

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: null };
    const started = Date.now();
    const code = await runProcess(ctx.spec.command ?? 'gemini', args, {
      cwd: ctx.workdir,
      onErr: (l) => ctx.log(`stderr: ${short(l)}`),
      onLine: (line) => {
        const m = tryJson(line);
        if (!m) return ctx.log(short(line));
        if (m.type === 'message' && m.role === 'assistant' && m.content) ctx.log(`💬 ${short(String(m.content))}`);
        if (m.type === 'tool_use') ctx.log(`🔧 ${m.tool_name ?? m.name} ${short(JSON.stringify(m.parameters ?? m.args ?? {}), 200)}`);
        if (m.type === 'error') ctx.log(`error: ${short(JSON.stringify(m))}`);
        const s = m.stats ?? m.usage;
        if (m.type === 'result' && s) {
          usage.inputTokens += s.input_tokens ?? s.prompt_tokens ?? 0;
          usage.outputTokens += s.output_tokens ?? s.candidates_tokens ?? 0;
          usage.cacheReadTokens += s.cached ?? s.cached_tokens ?? 0;
        }
      },
    });
    usage.durationMs = Date.now() - started;
    return { exitCode: code, usage };
  },
};
