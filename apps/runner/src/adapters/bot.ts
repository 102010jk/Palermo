import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPipeFor } from '../pipe.ts';
import type { Adapter, AgentContext, Launch, RunResult } from '../types.ts';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-bridge.mjs');

/**
 * Scripted player that talks to the server exactly like an AI agent would (over MCP), but decides randomly.
 * Costs no tokens. Useful for testing the MCP path and for filling seats.
 */
export async function playBotOverMcp(opts: {
  mcpUrl: string;
  token: string;
  gameId: string;
  name: string;
  log?: (l: string) => void;
  rand?: () => number;
  maxSteps?: number;
  /** Connect through the stdio bridge, exactly like Claude Code does. */
  viaBridge?: boolean;
  signal?: AbortSignal;
}): Promise<{ finished: boolean; steps: number }> {
  const log = opts.log ?? (() => {});
  const rand = opts.rand ?? Math.random;
  const client = new Client({ name: 'palermo-bot', version: '0.1.0' });
  const transport = opts.viaBridge
    ? new StdioClientTransport({
        command: process.execPath,
        args: [BRIDGE, opts.mcpUrl],
        env: { PALERMO_TOKEN: opts.token, ...(localPipeFor(opts.mcpUrl) ? { PALERMO_SOCKET: localPipeFor(opts.mcpUrl)! } : {}) },
        stderr: 'ignore',
      })
    : new StreamableHTTPClientTransport(new URL(opts.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
      });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 200_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const t = r.content.map((c) => c.text ?? '').join('\n');
    if (r.isError) log(`${name} -> ${t}`);
    return t;
  };

  await call('login', { model: 'random-bot', provider: 'script' });
  await call('join_game', { game_id: opts.gameId });
  await call('set_ready', { ready: true });

  let said = '';
  let steps = 0;
  const maxSteps = opts.maxSteps ?? 2000;
  let status = await call('get_state');
  while (steps++ < maxSteps) {
    if (opts.signal?.aborted) {
      await client.close();
      return { finished: false, steps };
    }
    if (/GAME OVER/.test(status)) {
      await call('submit_report', { summary: `${opts.name} (scripted bot) played randomly.`, lessons: 'Bots do not learn.' });
      await call('save_notes', { content: 'Scripted bot: no notes.' });
      await client.close();
      return { finished: true, steps };
    }
    const phase = /^== (.+?) \|/m.exec(status)?.[1] ?? '';
    const move = /^YOUR MOVE: (.*)$/m.exec(status)?.[1];
    const options = move ? (/Options: (.*)$/.exec(move)?.[1] ?? '').split(', ').filter(Boolean) : [];
    const choose = (xs: string[]) => xs[Math.floor(rand() * xs.length)];
    const mates = (/(?:mafia partners|fellow murderers): (.*)$/m.exec(status)?.[1] ?? '').split(', ').filter(Boolean);
    if (move && /^Mail Bird:/m.test(status)) {
      await call('mail_bird', { mode: 'none', thought: 'bots send no mail' });
    } else if (move && options.length && phase.startsWith('Night')) {
      await call('night_action', { target: choose(options), thought: 'random' });
    } else if (move && phase.startsWith('Day')) {
      const others = options.filter((o) => o !== 'skip');
      if (said !== phase && others.length) {
        said = phase;
        await call('say', { message: `I think ${choose(others)} is acting strange.`, thought: 'small talk' });
      } else {
        const cands = others.filter((o) => !mates.includes(o));
        await call('vote', { target: cands.length ? choose(cands) : 'skip', thought: 'random vote' });
      }
    }
    status = await call('wait_for_events', { max_wait_seconds: 30, min_new_messages: 1 });
  }
  await client.close();
  return { finished: false, steps };
}

export const botAdapter: Adapter = {
  async run(ctx: AgentContext, _launch: Launch): Promise<RunResult> {
    const r = await playBotOverMcp({
      mcpUrl: ctx.mcpUrl,
      token: ctx.token,
      gameId: ctx.gameId,
      name: ctx.spec.name,
      log: ctx.log,
      viaBridge: ctx.spec.mcpTransport === 'bridge',
      signal: ctx.signal,
    });
    ctx.log(`bot finished=${r.finished} after ${r.steps} steps`);
    return { exitCode: r.finished ? 0 : 1 };
  },
};
