import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as IoServer, type Socket } from 'socket.io';
import { DEFAULT_SETTINGS, GameError, ROLE_ORDER, type Game, type GameSettings, type GameState } from '@palermo/engine';
import { Auth, tokenFromRequest, type Principal } from './auth.ts';
import { Db } from './db.ts';
import { GameManager, type ManagerOptions } from './manager.ts';
import { mcpHandler } from './mcp.ts';
import { AgentPool, type PoolProvider } from './pool.ts';
import { computeStats } from './stats.ts';

export interface AppConfig {
  dataPath: string;
  adminToken: string;
  googleClientId: string | null;
  allowGuests: boolean;
  webDist: string | null;
  manager?: ManagerOptions;
  /** Also serve the API/MCP on this local IPC path (Windows named pipe or Unix socket). */
  pipePath?: string | null;
}

export interface PalermoApp {
  http: HttpServer;
  db: Db;
  manager: GameManager;
  auth: Auth;
  pool: AgentPool;
  close: () => Promise<void>;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal: Principal;
  }
}

export function createPalermo(cfg: AppConfig): PalermoApp {
  const db = new Db(cfg.dataPath);
  const auth = new Auth(db, cfg.adminToken, cfg.googleClientId);
  const manager = new GameManager(db, cfg.manager);
  const pool = new AgentPool(manager, auth, cfg.dataPath === ':memory:' ? null : join(dirname(cfg.dataPath), 'ai-pool.json'), (id) => db.tokenOf(id));
  const poolWatch = setInterval(() => pool.watch(), 10_000);
  poolWatch.unref();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.principal = auth.resolve(tokenFromRequest(req));
    next();
  });

  const ctx = { manager, db, auth };
  // MCP endpoint for AI agents.
  app.post('/mcp', mcpHandler(ctx));
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST (stateless Streamable HTTP).' }));
  app.delete('/mcp', (_req, res) => res.status(405).end());

  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await fn(req, res);
        if (out !== undefined && !res.headersSent) res.json(out);
      } catch (e) {
        if (e instanceof GameError || e instanceof HttpError) {
          res.status(e instanceof HttpError ? e.status : 400).json({ error: e.message });
        } else next(e);
      }
    };

  const requireAdmin = (req: Request) => {
    if (req.principal.type !== 'admin') {
      if (req.principal.type === 'account') {
        db.audit(null, req.principal.account.id, 'forbidden_admin', `${req.method} ${req.path}`);
      }
      throw new HttpError(403, 'Admin only.');
    }
  };
  const requireAccount = (req: Request) => {
    if (req.principal.type !== 'account') throw new HttpError(401, 'Log in first.');
    return req.principal.account;
  };
  const viewerFor = (req: Request, game: Game): string | null => {
    if (req.principal.type === 'admin') return null;
    if (req.principal.type === 'account') {
      const id = req.principal.account.id;
      const pid = game.state.players.find((p) => p.accountId === id)?.id;
      if (pid) return pid;
    }
    return 'spectator';
  };

  // ------------------------------------------------------------------ auth
  app.get('/api/config', (_req, res) => {
    res.json({ googleClientId: cfg.googleClientId, allowGuests: cfg.allowGuests, defaults: DEFAULT_SETTINGS });
  });
  app.get('/api/me', (req, res) => {
    const p = req.principal;
    res.json(p.type === 'admin' ? { admin: true } : p.type === 'account' ? { admin: false, account: p.account } : { admin: false });
  });
  app.post(
    '/api/auth/guest',
    wrap((req) => {
      if (!cfg.allowGuests) throw new HttpError(403, 'Guest login is disabled.');
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Name required.');
      return auth.createGuest(name);
    }),
  );
  app.post(
    '/api/auth/google',
    wrap(async (req) => {
      try {
        return await auth.google(String(req.body?.credential ?? ''));
      } catch (e) {
        throw new HttpError(401, (e as Error).message);
      }
    }),
  );

  // ------------------------------------------------------------------ admin: AI waiting list
  const PROVIDERS = new Set<PoolProvider>(['claude', 'codex', 'agy', 'gemini', 'bot']);
  app.get('/api/admin/pool', wrap((req) => (requireAdmin(req), pool.status())));
  app.post(
    '/api/admin/pool/picks',
    wrap((req) => {
      requireAdmin(req);
      const b = req.body ?? {};
      if (!PROVIDERS.has(b.provider) || typeof b.model !== 'string' || !b.model) throw new HttpError(400, 'provider and model required');
      const count = Math.min(10, Math.max(1, Number(b.count) || 1));
      for (let i = 0; i < count; i++) pool.add({ provider: b.provider, model: b.model, label: b.label, name: b.name, repeat: b.repeat });
      return pool.status();
    }),
  );
  app.patch(
    '/api/admin/pool/picks/:id',
    wrap((req) => (requireAdmin(req), pool.update(String(req.params.id), req.body ?? {}), pool.status())),
  );
  app.delete(
    '/api/admin/pool/picks/:id',
    wrap((req) => (requireAdmin(req), pool.remove(String(req.params.id)), pool.status())),
  );
  app.post(
    '/api/admin/series',
    wrap((req) => {
      requireAdmin(req);
      const settings = sanitizeSettings(req.body?.settings ?? {});
      const total = Math.floor(Number(req.body?.count ?? 0));
      if (!(total >= 2)) throw new HttpError(400, 'A series needs at least 2 games.');
      const x = pool.startSeries({ ...settings, autoStart: true, aiPool: true }, total);
      return { id: x.id, firstGame: x.gameIds[0] };
    }),
  );
  app.post('/api/admin/series/:id/stop', wrap((req) => (requireAdmin(req), pool.stopSeries(String(req.params.id)), pool.status())));
  // Used by the agent launcher on the player's PC (runner --pool).
  app.post('/api/admin/pool/hello', wrap((req) => (requireAdmin(req), pool.hello(req.body ?? {}))));
  app.post(
    '/api/admin/pool/finish',
    wrap((req) => {
      requireAdmin(req);
      const b = req.body ?? {};
      pool.finish(String(b.pickId), b.gameId ? String(b.gameId) : undefined, b.error ? String(b.error) : undefined);
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------------ admin: agents
  app.post(
    '/api/admin/agents',
    wrap((req) => {
      requireAdmin(req);
      const b = req.body ?? {};
      return auth.createAgent({ name: String(b.name ?? 'Agent'), provider: b.provider ?? null, model: b.model ?? null, verified: b.verified !== false });
    }),
  );
  app.get('/api/admin/agents', wrap((req) => (requireAdmin(req), db.listAccounts('ai'))));
  // The runner reports the exact model the CLI resolved (e.g. "sonnet" -> "claude-sonnet-5").
  app.patch(
    '/api/admin/agents/:id',
    wrap((req) => {
      requireAdmin(req);
      const id = String(req.params.id);
      if (!db.accountById(id)) throw new HttpError(404, 'Unknown agent.');
      const model = req.body?.model ? String(req.body.model).slice(0, 80) : undefined;
      if (model) {
        db.updateAccount(id, { model });
        manager.updateAccountModel(id, model);
      }
      return db.accountById(id);
    }),
  );
  app.get('/api/admin/audit', wrap((req) => (requireAdmin(req), db.auditLog(req.query.game ? String(req.query.game) : undefined))));
  app.get('/api/admin/notes', wrap((req) => (requireAdmin(req), db.allLatestNotes())));
  app.get('/api/admin/notes/history', wrap((req) => (requireAdmin(req), db.notesHistory(String(req.query.model ?? '')))));

  // ------------------------------------------------------------------ usage reporting (runner)
  app.post(
    '/api/usage',
    wrap((req) => {
      const p = req.principal;
      if (p.type === 'anonymous') throw new HttpError(401, 'Token required.');
      const b = req.body ?? {};
      const accountId = p.type === 'account' ? p.account.id : (b.accountId ?? null);
      db.addUsage({
        gameId: b.gameId ?? null,
        accountId,
        model: b.model ?? (p.type === 'account' ? p.account.model : null),
        inputTokens: Number(b.inputTokens ?? 0),
        outputTokens: Number(b.outputTokens ?? 0),
        cacheReadTokens: Number(b.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(b.cacheWriteTokens ?? 0),
        costUsd: b.costUsd == null ? null : Number(b.costUsd),
        durationMs: b.durationMs == null ? null : Number(b.durationMs),
        source: String(b.source ?? 'runner'),
      });
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------------ games
  const gameSummary = (row: Record<string, unknown>) => {
    // Live games from memory; finished ones from the small snapshot (never load their full event log here).
    const live = manager.liveGame(row.id as string)?.state ?? (JSON.parse(row.state as string) as GameState);
    return {
      id: row.id,
      phase: row.phase,
      winner: row.winner,
      playerCount: row.player_count,
      settings: JSON.parse(row.settings as string),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      round: live.round || null,
      paused: !!live.pausedAt,
      aborted: !!live.aborted,
      players: live.players.map((p) => {
        // Anonymous games must not reveal who is behind a seat while they run.
        const hide = live.settings.identityVisibility === 'anonymous' && live.phase !== 'lobby' && live.phase !== 'ended';
        return { name: p.publicName, kind: hide ? undefined : p.kind, model: hide ? undefined : p.model, ready: p.ready, alive: p.alive };
      }),
    };
  };
  const listGames = () => db.listGames(200).map(gameSummary);
  app.get('/api/games', wrap(() => listGames()));

  app.post(
    '/api/games',
    wrap((req) => {
      requireAdmin(req);
      const settings = sanitizeSettings(req.body?.settings ?? {});
      const g = manager.create(settings);
      return { id: g.state.id, settings: g.settings };
    }),
  );

  const gamePayload = (req: Request, game: Game) => {
    const viewer = viewerFor(req, game);
    const since = Number(req.query.since ?? 0);
    const out: Record<string, unknown> = {
      view: game.view(viewer === 'spectator' ? '__spectator__' : viewer),
      events: game.eventsFor(viewer === 'spectator' ? '__spectator__' : viewer, since),
    };
    if (game.state.phase === 'ended' || viewer === null) out.reports = db.reports(game.state.id);
    if (viewer === null) {
      out.audit = db.auditLog(game.state.id);
      out.usage = db.sql.prepare('SELECT * FROM usage WHERE game_id = ? ORDER BY id').all(game.state.id);
    }
    return out;
  };

  app.get(
    '/api/games/:id',
    wrap((req) => {
      const game = manager.get(String(req.params.id));
      if (!game) throw new HttpError(404, 'Unknown game.');
      return gamePayload(req, game);
    }),
  );

  const playerAction = (fn: (game: Game, playerId: string, body: Record<string, unknown>) => void) =>
    wrap((req) => {
      const account = requireAccount(req);
      const id = String(req.params.id);
      const game = manager.get(id);
      if (!game) throw new HttpError(404, 'Unknown game.');
      const pid = game.state.players.find((p) => p.accountId === account.id)?.id;
      if (!pid) throw new HttpError(403, 'You are not in this game.');
      fn(game, pid, req.body ?? {});
      return { ok: true };
    });

  app.post(
    '/api/games/:id/join',
    wrap((req) => {
      const account = requireAccount(req);
      const pid = manager.joinAccount(String(req.params.id), account, req.body?.name ? String(req.body.name) : undefined);
      return { playerId: pid };
    }),
  );
  app.post('/api/games/:id/leave', playerAction((g, pid) => manager.apply(g.state.id, (x) => x.removePlayer(pid))));
  app.post('/api/games/:id/ready', playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.setReady(pid, b.ready !== false))));
  app.post('/api/games/:id/say', playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.say(pid, String(b.message ?? '')))));
  app.post(
    '/api/games/:id/vote',
    playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.vote(pid, b.target == null ? null : String(b.target)))),
  );
  app.post(
    '/api/games/:id/night',
    playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.nightAction(pid, String(b.target ?? '')))),
  );
  app.post(
    '/api/games/:id/shoot',
    playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.shoot(pid, String(b.target ?? '')))),
  );
  app.post(
    '/api/games/:id/throw_voice',
    playerAction((g, pid, b) => manager.apply(g.state.id, (x) => x.throwVoice(pid, String(b.as ?? ''), String(b.message ?? '')))),
  );

  // admin game controls
  const adminAction = (fn: (id: string, body: Record<string, unknown>) => unknown) =>
    wrap((req) => {
      requireAdmin(req);
      return fn(String(req.params.id), req.body ?? {}) ?? { ok: true };
    });
  app.post('/api/games/:id/start', adminAction((id, b) => void manager.apply(id, (g) => g.start(b.force === true))));
  app.post('/api/games/:id/advance', adminAction((id) => void manager.apply(id, (g) => g.forceAdvance())));
  app.post('/api/games/:id/abort', adminAction((id) => void manager.apply(id, (g) => g.abort())));
  app.post('/api/games/:id/pause', adminAction((id, b) => void manager.apply(id, (g) => g.pause(String(b.reason ?? 'paused by the host').slice(0, 200)))));
  app.post('/api/games/:id/resume', adminAction((id) => void manager.apply(id, (g) => g.resume())));
  // A runner's agent ran out of usage: pause until that player is back (it checks in with its next MCP call).
  app.post(
    '/api/admin/games/:id/pause-for',
    adminAction((id, b) => void manager.apply(id, (g) => g.pause(String(b.reason ?? 'a player is away').slice(0, 200), String(b.accountId ?? '')))),
  );
  // Seats of AI players with their tokens, so a restarted runner can sit them down again.
  app.get(
    '/api/admin/games/:id/seats',
    wrap((req) => {
      requireAdmin(req);
      const game = manager.get(String(req.params.id));
      if (!game) throw new HttpError(404, 'Unknown game.');
      return game.state.players
        .filter((p) => p.kind === 'ai' && p.accountId)
        .map((p) => ({ name: p.name, accountId: p.accountId, token: db.tokenOf(p.accountId!), provider: p.provider, model: p.model, alive: p.alive }));
    }),
  );
  app.post('/api/games/:id/bots', adminAction((id, b) => {
    const n = Math.min(20, Math.max(1, Number(b.count ?? 1)));
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(manager.addBot(id));
    return { ids };
  }));
  app.delete(
    '/api/games/:id',
    wrap((req) => {
      requireAdmin(req);
      manager.deleteGame(String(req.params.id));
      manager.emit('games');
      return { ok: true };
    }),
  );
  // Full record of one game (settings = the rules it was played with, every event, reports, token usage).
  app.get(
    '/api/admin/games/:id/export',
    wrap((req, res) => {
      requireAdmin(req);
      const game = manager.get(String(req.params.id));
      if (!game) throw new HttpError(404, 'Unknown game.');
      const id = game.state.id;
      res.setHeader('content-disposition', `attachment; filename="palermo-${id}.json"`);
      return {
        format: 'palermo-game/1',
        exportedAt: new Date().toISOString(),
        settings: game.settings,
        state: game.state,
        players: db.sql.prepare('SELECT * FROM game_players WHERE game_id = ?').all(id),
        reports: db.reports(id),
        usage: db.sql.prepare('SELECT * FROM usage WHERE game_id = ? ORDER BY id').all(id),
        audit: db.auditLog(id),
      };
    }),
  );
  // One row per player of every finished game, for spreadsheets and analysis.
  app.get(
    '/api/admin/export.csv',
    wrap((req, res) => {
      requireAdmin(req);
      const rows = db.sql
        .prepare(
          `SELECT g.id AS game_id, g.ended_at, g.settings, g.state, g.winner, p.name, p.kind, p.provider, p.model, p.role, p.team,
                  p.won, p.survived, p.death_round, p.death_cause
             FROM games g JOIN game_players p ON p.game_id = g.id WHERE g.phase = 'ended' ORDER BY g.ended_at, p.player_id`,
        )
        .all() as Record<string, unknown>[];
      const cols = ['game_id', 'ended_at', 'aborted', 'mode', 'gameStyle', 'series', 'killMode', 'winner', 'rounds', 'name', 'kind', 'provider', 'model', 'role', 'team', 'won', 'survived', 'death_round', 'death_cause'];
      const esc = (v: unknown) => {
        const t = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const lines = [cols.join(',')];
      for (const r of rows) {
        const st = JSON.parse(String(r.settings));
        const state = JSON.parse(String(r.state)) as GameState;
        const row: Record<string, unknown> = {
          ...r,
          ended_at: r.ended_at ? new Date(Number(r.ended_at)).toISOString() : '',
          aborted: state.aborted ? 1 : 0,
          mode: st.mode,
          gameStyle: st.gameStyle ?? 'simulation',
          series: st.series ?? '',
          killMode: st.killMode ?? 'shared',
          rounds: state.round,
        };
        lines.push(cols.map((c) => esc(row[c])).join(','));
      }
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="palermo-games.csv"');
      res.send(lines.join('\n'));
      return undefined;
    }),
  );
  app.post('/api/games/:id/kick', adminAction((id, b) => void manager.apply(id, (g) => g.removePlayer(String(b.playerId)))));

  app.get('/api/games/:id/reports', wrap((req) => db.reports(String(req.params.id))));

  // ------------------------------------------------------------------ stats
  app.get(
    '/api/stats',
    wrap((req) => {
      const settings: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k.startsWith('s.') && typeof v === 'string') settings[k.slice(2)] = v;
      }
      return computeStats(db, {
        settings,
        playerCount: req.query.players ? Number(req.query.players) : undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
      });
    }),
  );
  app.get('/api/reports', wrap(() => db.reports()));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ------------------------------------------------------------------ static web app
  if (cfg.webDist && existsSync(cfg.webDist)) {
    app.use(express.static(cfg.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/mcp|\/socket\.io).*/, (_req, res) => res.sendFile(join(cfg.webDist!, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  // ------------------------------------------------------------------ realtime (web UI)
  const http = createServer(app);
  // Local IPC endpoint for the agents' MCP bridge: invisible to proxies and HTTP-scanning security software.
  let pipe: HttpServer | null = null;
  if (cfg.pipePath) {
    if (process.platform !== 'win32') rmSync(cfg.pipePath, { force: true });
    pipe = createServer(app);
    pipe.requestTimeout = 0;
    pipe.on('error', (e) => console.warn(`[server] local pipe ${cfg.pipePath} unavailable: ${e.message}`));
    pipe.listen(cfg.pipePath);
  }
  // Long-polling MCP tool calls can take a while.
  http.requestTimeout = 0;
  http.headersTimeout = 130_000;
  const io = new IoServer(http, { cors: { origin: true } });

  interface Watch {
    gameId: string;
    lastSeq: number;
  }
  const viewerForSocket = (socket: Socket, game: Game): string | null => {
    const p = socket.data.principal as Principal;
    if (socket.data.isAdmin && socket.data.adminView) return null;
    if (p.type === 'account') {
      const pid = game.state.players.find((x) => x.accountId === p.account.id)?.id;
      if (pid) return pid;
    }
    return '__spectator__';
  };
  const push = (socket: Socket, full = false) => {
    const w = socket.data.watch as Watch | undefined;
    if (!w) return;
    const game = manager.get(w.gameId);
    if (!game) return;
    const viewer = viewerForSocket(socket, game);
    const since = full ? 0 : w.lastSeq;
    const events = game.eventsFor(viewer, since);
    w.lastSeq = game.state.events.length;
    socket.emit(full ? 'snapshot' : 'update', { view: game.view(viewer), events });
  };

  io.on('connection', (socket) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    const adminToken = typeof socket.handshake.auth?.adminToken === 'string' ? socket.handshake.auth.adminToken : null;
    socket.data.principal = auth.resolve(token);
    socket.data.isAdmin = socket.data.principal.type === 'admin' || (!!adminToken && auth.resolve(adminToken).type === 'admin');
    socket.emit('games', listGames());
    socket.on('watch', (msg: { gameId: string; adminView?: boolean }) => {
      const prev = socket.data.watch as Watch | undefined;
      if (prev) socket.leave(`game:${prev.gameId}`);
      socket.data.watch = { gameId: String(msg?.gameId), lastSeq: 0 };
      socket.data.adminView = msg?.adminView !== false;
      socket.join(`game:${msg?.gameId}`);
      push(socket, true);
    });
    socket.on('unwatch', () => {
      const prev = socket.data.watch as Watch | undefined;
      if (prev) socket.leave(`game:${prev.gameId}`);
      socket.data.watch = undefined;
    });
  });

  manager.on('change', async (gameId: string) => {
    for (const s of await io.in(`game:${gameId}`).fetchSockets()) {
      const sock = io.sockets.sockets.get(s.id);
      if (sock) push(sock);
    }
  });
  manager.on('reports', (gameId: string) => io.to(`game:${gameId}`).emit('reports', db.reports(gameId)));
  let gamesTimer: NodeJS.Timeout | null = null;
  manager.on('games', () => {
    if (gamesTimer) return;
    gamesTimer = setTimeout(() => {
      gamesTimer = null;
      io.emit('games', listGames());
    }, 200);
  });

  return {
    http,
    db,
    manager,
    auth,
    pool,
    close: async () => {
      clearInterval(poolWatch);
      manager.close();
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
      if (pipe) await new Promise<void>((r) => pipe!.close(() => r()));
      db.sql.close();
    },
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BOOL_KEYS = ['revealRoleOnDeath', 'publicVotes', 'allowSkipVote', 'freedomMode', 'doctorNoRepeat', 'doctorLearnsSave', 'autoStart', 'announceRoles', 'aiPool'] as const;
const NUM_OR_NULL = ['nightTimeoutSec', 'dayTimeoutSec', 'maxRounds', 'maxMessageLength', 'maxMessagesPerPhase', 'chatCooldownSec', 'voteDeadlineSec'] as const;

/** Accept only known settings with sane types from the admin UI / runner. */
export function sanitizeSettings(input: Record<string, unknown>): Partial<GameSettings> {
  const out: Partial<GameSettings> = {};
  if (typeof input.mode === 'string') out.mode = input.mode.slice(0, 40);
  if (input.roles === 'auto') out.roles = 'auto';
  else if (Array.isArray(input.roles)) {
    out.roles = input.roles.filter((r) => (ROLE_ORDER as string[]).includes(String(r))) as GameSettings['roles'];
  }
  if (input.roleCounts === null) out.roleCounts = null;
  else if (input.roleCounts && typeof input.roleCounts === 'object') {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.roleCounts as Record<string, unknown>)) {
      const n = Math.floor(Number(v));
      if ((ROLE_ORDER as string[]).includes(k) && k !== 'civilian' && n > 0) counts[k] = Math.min(20, n);
    }
    out.roleCounts = Object.keys(counts).length ? (counts as GameSettings['roleCounts']) : null;
  }
  if (input.killMode === 'separate' || input.killMode === 'shared') out.killMode = input.killMode;
  if (input.gameStyle === 'visual' || input.gameStyle === 'simulation') out.gameStyle = input.gameStyle;
  if (input.startPhase === 'day' || input.startPhase === 'night') out.startPhase = input.startPhase;
  if (input.identityVisibility === 'visible' || input.identityVisibility === 'anonymous') out.identityVisibility = input.identityVisibility;
  if (['none', 'own', 'shared'].includes(String(input.notesMode))) out.notesMode = input.notesMode as GameSettings['notesMode'];
  if (['never', 'once', 'always'].includes(String(input.doctorSelfProtect))) out.doctorSelfProtect = input.doctorSelfProtect as GameSettings['doctorSelfProtect'];
  for (const k of BOOL_KEYS) if (typeof input[k] === 'boolean') (out as Record<string, unknown>)[k] = input[k];
  for (const k of NUM_OR_NULL) {
    if (input[k] === null) (out as Record<string, unknown>)[k] = null;
    else if (Number.isFinite(Number(input[k])) && input[k] !== undefined && input[k] !== '') (out as Record<string, unknown>)[k] = Math.max(1, Number(input[k]));
  }
  if (Number.isFinite(Number(input.minPlayers)) && input.minPlayers !== undefined) out.minPlayers = Math.max(3, Number(input.minPlayers));
  if (Number.isFinite(Number(input.seats)) && input.seats !== undefined) out.seats = Math.max(0, Number(input.seats));
  return out;
}
