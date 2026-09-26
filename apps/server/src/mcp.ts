import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GameError, type Game } from '@palermo/engine';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import type { Account, Db } from './db.ts';
import { formatEvents, formatStatus } from './format.ts';
import type { GameManager } from './manager.ts';
import { tokenFromRequest } from './auth.ts';

export const MCP_INSTRUCTIONS = `Palermo is a Mafia-style social deduction game played by AI models and humans.
Protocol:
1. Call login first (always).
2. join_game, then set_ready.
3. Loop: wait_for_events -> react (say / vote / night_action) -> wait_for_events ... until the game is over.
4. When the game is over: submit_report, then save_notes, then stop.
Your only goal is to WIN for your team. Every action accepts a private "thought" that only the game master sees.`;

type Ctx = { manager: GameManager; db: Db; auth: Auth };

/** Accounts that called login since the server started. */
const loggedIn = new Set<string>();

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}
function fail(t: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${t}` }], isError: true };
}

/** "sonnet" vs "claude-sonnet-5": aliases count as the same model. */
function sameModel(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

export function modelKey(a: { provider: string | null; model: string | null; name: string }): string {
  return a.model ? `${a.provider ?? 'unknown'}:${a.model}` : `agent:${a.name}`;
}

function buildServer(ctx: Ctx, account: Account): McpServer {
  const { manager, db } = ctx;
  const server = new McpServer({ name: 'palermo', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });

  const guard = <A>(fn: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>, needLogin = true) =>
    async (args: A) => {
      if (needLogin && !loggedIn.has(account.id)) return fail('You must call login first.');
      try {
        return await fn(args);
      } catch (e) {
        if (e instanceof GameError) return fail(e.message);
        console.error(e);
        return fail('Internal error.');
      }
    };

  const seat = (gameId?: string): { game: Game; playerId: string } => {
    const game = gameId ? manager.get(gameId) : manager.currentGameFor(account.id);
    if (!game) throw new GameError(gameId ? `Unknown game "${gameId}".` : 'You are not in a game. Use list_games and join_game.');
    const playerId = game.state.players.find((p) => p.accountId === account.id)?.id;
    if (!playerId) throw new GameError(`You are not seated in game ${game.state.id}. Use join_game first.`);
    return { game, playerId };
  };

  // Tool annotations let clients (e.g. Codex) run the game tools without asking: none of them touches the
  // player's machine or the outside world, and the reading ones change nothing.
  const READ_ONLY = new Set(['list_games', 'wait_for_events', 'get_state', 'get_history', 'get_notes']);
  const registerTool = ((name: string, config: { annotations?: object }, cb: unknown) =>
    (server.registerTool as any)(
      name,
      { ...config, annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false, ...config.annotations } },
      cb,
    )) as typeof server.registerTool;

  const lobbies = () =>
    manager
      .liveGames()
      .filter((g) => g.state.phase === 'lobby')
      .map((g) => `${g.state.id} (${g.settings.mode}, ${g.state.players.length} joined${g.settings.seats ? `/${g.settings.seats}` : ''})`);

  registerTool(
    'login',
    {
      description: 'Log in to the Palermo server. Must be the first call. Report which model you are.',
      inputSchema: {
        model: z.string().max(80).optional().describe('Your exact model name, e.g. "claude-opus-5" or "gemini-flash"'),
        provider: z.string().max(40).optional().describe('anthropic, openai, google, ...'),
        display_name: z.string().max(32).optional(),
      },
    },
    guard(async (args: { model?: string; provider?: string; display_name?: string }) => {
      if (!account.verified) {
        db.updateAccount(account.id, {
          model: args.model ?? account.model,
          provider: args.provider ?? account.provider,
          name: args.display_name ?? account.name,
        });
        Object.assign(account, db.accountById(account.id));
      } else if (args.model && account.model && !sameModel(args.model, account.model)) {
        db.audit(null, account.id, 'model_mismatch', `claimed ${args.model}, verified as ${account.model}`);
      }
      loggedIn.add(account.id);
      const current = manager.currentGameFor(account.id);
      const l = lobbies();
      return text(
        `Logged in as ${account.name} (${account.model ?? 'unknown model'}${account.verified ? ', verified' : ', self-reported'}).\n` +
          (current
            ? `You are seated in game ${current.state.id}. Continue with wait_for_events.`
            : l.length
              ? `Open lobbies: ${l.join('; ')}. Use join_game.`
              : 'No open lobby right now. Call list_games again later.'),
      );
    }, false),
  );

  registerTool(
    'list_games',
    { description: 'List games you can join (lobbies) and games in progress.', inputSchema: {} },
    guard(async () => {
      const games = manager.liveGames();
      if (!games.length) return text('No games.');
      return text(
        games
          .map((g) => `${g.state.id}: ${g.state.phase}, mode ${g.settings.mode}, ${g.state.players.length} players`)
          .join('\n'),
      );
    }),
  );

  registerTool(
    'join_game',
    {
      description: 'Join a game lobby. Without game_id joins the only open lobby.',
      inputSchema: { game_id: z.string().optional() },
    },
    guard(async ({ game_id }: { game_id?: string }) => {
      let gameId = game_id;
      if (!gameId) {
        const current = manager.currentGameFor(account.id);
        const open = manager.liveGames().filter((g) => g.state.phase === 'lobby');
        if (current) gameId = current.state.id;
        else if (open.length === 1) gameId = open[0].state.id;
        else if (!open.length) throw new GameError('No open lobby. Try list_games later.');
        else throw new GameError(`Several lobbies are open, pass game_id: ${lobbies().join('; ')}`);
      }
      const playerId = manager.joinAccount(gameId, account);
      const g = manager.get(gameId)!;
      return text(`Joined game ${gameId}. Now call set_ready, then wait_for_events.\n\n${formatStatus(g, playerId)}`);
    }),
  );

  registerTool(
    'set_ready',
    { description: 'Mark yourself ready (or not ready) in the lobby.', inputSchema: { ready: z.boolean().default(true) } },
    guard(async ({ ready }: { ready?: boolean }) => {
      const { game, playerId } = seat();
      manager.apply(game.state.id, (g) => g.setReady(playerId, ready ?? true));
      return text(`You are ${ready === false ? 'not ready' : 'ready'}. Call wait_for_events to wait for the game to start.`);
    }),
  );

  registerTool(
    'leave_game',
    { description: 'Leave a lobby before the game starts.', inputSchema: {} },
    guard(async () => {
      const { game, playerId } = seat();
      manager.apply(game.state.id, (g) => g.removePlayer(playerId));
      return text('You left the lobby.');
    }),
  );

  registerTool(
    'wait_for_events',
    {
      description:
        'Block until something relevant happens, then return all new events plus your current status. ' +
        'This is how you "listen". Call it again after every action. Returns early on phase changes, results, ' +
        'when you are mentioned, when you are the last one to vote, when min_new_messages arrived, or a few ' +
        'seconds after the chat goes quiet. The defaults are good; long waits are cheap.',
      inputSchema: {
        // Larger values are clamped (some models ask for 600 s); the server wakes agents early anyway.
        max_wait_seconds: z.number().min(1).default(110).transform((n) => Math.min(120, Math.round(n))),
        min_new_messages: z.number().int().min(1).max(50).default(2).describe('Wake after this many new messages (raise it to save tokens)'),
        wake_on_mention: z.boolean().default(true),
      },
    },
    guard(async (args: { max_wait_seconds?: number; min_new_messages?: number; wake_on_mention?: boolean }) => {
      const { game, playerId } = seat();
      const events = await manager.waitForEvents(game.state.id, playerId, {
        maxWaitSec: args.max_wait_seconds ?? 110,
        minMessages: args.min_new_messages ?? 2,
        wakeOnMention: args.wake_on_mention ?? true,
      });
      return text(`${formatEvents(events)}\n\n${formatStatus(manager.get(game.state.id)!, playerId)}`);
    }),
  );

  registerTool(
    'get_state',
    { description: 'Your current status (role, alive players, votes, what you should do). Does not wait.', inputSchema: {} },
    guard(async () => {
      const { game, playerId } = seat();
      return text(formatStatus(game, playerId));
    }),
  );

  registerTool(
    'get_history',
    {
      description: 'Everything you have seen in this game so far (or the last N events). Use only if you lost track.',
      inputSchema: { last: z.number().int().min(1).max(500).optional() },
    },
    guard(async ({ last }: { last?: number }) => {
      const { game, playerId } = seat();
      const events = game.eventsFor(playerId);
      return text(formatEvents(last ? events.slice(-last) : events));
    }),
  );

  const thought = z.string().max(2000).optional().describe('Your private reasoning. Only the game master sees it.');

  registerTool(
    'say',
    {
      description: 'Send a chat message. Day: everyone reads it. Night: only your fellow murderers (murderers only).',
      inputSchema: { message: z.string().min(1).max(2000), thought },
    },
    guard(async (args: { message: string; thought?: string }) => {
      const { game, playerId } = seat();
      manager.apply(game.state.id, (g) => g.say(playerId, args.message, args.thought));
      return text('Sent. Call wait_for_events to hear replies.');
    }),
  );

  registerTool(
    'vote',
    {
      description:
        'Day only: vote to eliminate a player (by name), "skip" for no elimination, or "none" to withdraw. ' +
        'You may change your vote. The day ends when every living player has voted.',
      inputSchema: { target: z.string().min(1).max(40), thought },
    },
    guard(async (args: { target: string; thought?: string }) => {
      const { game, playerId } = seat();
      const t = args.target.trim().toLowerCase() === 'none' ? null : args.target;
      manager.apply(game.state.id, (g) => g.vote(playerId, t, args.thought));
      const g = manager.get(game.state.id)!;
      return text(`Vote recorded.\n\n${formatStatus(g, playerId)}`);
    }),
  );

  registerTool(
    'night_action',
    {
      description:
        'Night only: use your role ability on a player (murderer: kill, or target "pass" to stay home; doctor: protect; ' +
        'tracker: follow; trapper: trap their house).',
      inputSchema: { target: z.string().min(1).max(40), thought },
    },
    guard(async (args: { target: string; thought?: string }) => {
      const { game, playerId } = seat();
      manager.apply(game.state.id, (g) => g.nightAction(playerId, args.target, args.thought));
      return text('Night action recorded. You may change it until the night ends. Call wait_for_events.');
    }),
  );

  registerTool(
    'shoot',
    {
      description:
        'Gunman only, during the day: fire your single bullet at a player. They die at once and everyone learns you are the Gunman.',
      inputSchema: { target: z.string().min(1).max(40), thought },
      annotations: { destructiveHint: false },
    },
    guard(async (args: { target: string; thought?: string }) => {
      const { game, playerId } = seat();
      manager.apply(game.state.id, (g) => g.shoot(playerId, args.target, args.thought));
      return text(formatStatus(manager.get(game.state.id)!, playerId));
    }),
  );

  registerTool(
    'get_notes',
    {
      description:
        'Read the playbook written after previous games (during a game only if the game allows it). ' +
        'After the game it always returns the latest version of your own playbook, so you can merge before save_notes.',
      inputSchema: {},
    },
    guard(async () => {
      const current = manager.currentGameFor(account.id);
      const over = !current || current.state.phase === 'ended';
      const mode = current?.settings.notesMode ?? 'own';
      const own = () => {
        const n = db.latestNotes(modelKey(account));
        return n ? n.content : 'No notes yet.';
      };
      // After the game nothing can leak into play; always show the latest own playbook so merges don't lose lessons.
      if (over) return text(`Latest playbook for ${modelKey(account)} (other players of your model may have updated it):\n\n${own()}`);
      if (mode === 'none') return text('Notes are disabled for this game. Rely on your own judgement.');
      if (mode === 'shared') {
        const all = db.allLatestNotes();
        if (!all.length) return text('No notes yet.');
        return text(all.map((n) => `### Notes of ${n.modelKey}\n${n.content}`).join('\n\n'));
      }
      const n = db.latestNotes(modelKey(account));
      return text(n ? n.content : 'No notes yet. This is your first game.');
    }),
  );

  registerTool(
    'save_notes',
    {
      description:
        'Replace your playbook with an updated version (after a game). First call get_notes to fetch the LATEST version ' +
        '(other players of your model may have saved theirs meanwhile), then merge old lessons with yours and keep it ' +
        'short and general (max ~600 words). Do not store facts about specific seat assignments, roles are random.',
      inputSchema: { content: z.string().min(1).max(8000) },
    },
    guard(async ({ content }: { content: string }) => {
      const gameId = manager.currentGameFor(account.id)?.state.id ?? db.lastGameIdFor(account.id);
      db.saveNotes(modelKey(account), account.id, gameId, content);
      return text('Notes saved.');
    }),
  );

  registerTool(
    'submit_report',
    {
      description: 'After the game ends: submit your summary of the game and the lessons you learned.',
      inputSchema: {
        summary: z.string().min(1).max(4000).describe('What happened, from your point of view, incl. your role and key moments'),
        lessons: z.string().min(1).max(4000).describe('What you would do differently / what worked'),
      },
    },
    guard(async (args: { summary: string; lessons: string }) => {
      const gameId = manager.currentGameFor(account.id)?.state.id ?? db.lastGameIdFor(account.id);
      if (!gameId) throw new GameError('You have not played a game yet.');
      const game = manager.get(gameId)!;
      if (game.state.phase !== 'ended') throw new GameError('The game is not over yet. Keep playing.');
      const { playerId } = seat(gameId);
      db.saveReport({ gameId, playerId, accountId: account.id, model: account.model, summary: args.summary, lessons: args.lessons });
      manager.emit('reports', gameId);
      return text('Report saved. Now save_notes, then you are done. Stop playing.');
    }),
  );

  return server;
}

/** Express handler for the MCP endpoint (stateless Streamable HTTP; auth by bearer token or ?token=). */
export function mcpHandler(ctx: Ctx) {
  return async (req: Request, res: Response) => {
    const principal = ctx.auth.resolve(tokenFromRequest(req));
    if (principal.type !== 'account') {
      console.warn(`[mcp] rejected request without a valid token from ${req.ip}`);
      if (tokenFromRequest(req)) ctx.db.audit(null, null, 'mcp_bad_token', `from ${req.ip}`);
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing or invalid token. Ask the game host for an agent token.' },
        id: null,
      });
      return;
    }
    const account = principal.account;
    const body = req.body;
    res.on('finish', () => {
      if (res.statusCode >= 400) console.warn(`[mcp] ${account.name}: ${body?.method ?? '?'} -> HTTP ${res.statusCode}`);
    });
    if (body?.method === 'initialize') {
      const p = body.params ?? {};
      console.log(`[mcp] ${account.name} connected (client ${p.clientInfo?.name ?? '?'} ${p.clientInfo?.version ?? ''}, protocol ${p.protocolVersion ?? '?'})`);
    }
    if (body?.method === 'initialize' && body.params?.clientInfo) {
      const ci = body.params.clientInfo;
      ctx.db.updateAccount(account.id, { client: `${ci.name ?? '?'} ${ci.version ?? ''}`.trim().slice(0, 80) });
    }
    // New clients first probe for the 2026 protocol. Answer like a 2025-era server ("method not found"),
    // so the client falls back to initialize, without going through the SDK's 400 path.
    if (body?.method === 'server/discover') {
      res.status(200).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const server = buildServer(ctx, account);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error(`[mcp] ${account.name}: ${body?.method ?? '?'} failed:`, e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: 'Internal error' } });
    }
  };
}
