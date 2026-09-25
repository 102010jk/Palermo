import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GameEvent, GameState } from '@palermo/engine';

export type AccountKind = 'human' | 'ai';

export interface Account {
  id: string;
  kind: AccountKind;
  name: string;
  email: string | null;
  provider: string | null;
  model: string | null;
  /** Model identity was set by the admin/runner, not self-reported by the agent. */
  verified: boolean;
  client: string | null;
  createdAt: number;
}

export interface Usage {
  gameId: string | null;
  accountId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  source: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  provider TEXT,
  model TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  client TEXT,
  token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  phase TEXT NOT NULL,
  winner TEXT,
  player_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  account_id TEXT,
  name TEXT NOT NULL,
  public_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  team TEXT,
  survived INTEGER,
  won INTEGER,
  death_round INTEGER,
  death_cause TEXT,
  PRIMARY KEY (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS events (
  game_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,
  type TEXT NOT NULL,
  vis TEXT NOT NULL,
  actor TEXT,
  text TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_key TEXT NOT NULL,
  account_id TEXT,
  game_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_model ON notes (model_key, id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  account_id TEXT,
  model TEXT,
  summary TEXT NOT NULL,
  lessons TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT,
  account_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT,
  account_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

function toAccount(r: Row): Account {
  return {
    id: r.id as string,
    kind: r.kind as AccountKind,
    name: r.name as string,
    email: (r.email as string) ?? null,
    provider: (r.provider as string) ?? null,
    model: (r.model as string) ?? null,
    verified: !!r.verified,
    client: (r.client as string) ?? null,
    createdAt: r.created_at as number,
  };
}

export class Db {
  sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.sql.exec(SCHEMA);
  }

  // accounts ---------------------------------------------------------------

  createAccount(a: Omit<Account, 'createdAt'> & { token: string }): Account {
    this.sql
      .prepare(
        'INSERT INTO accounts (id, kind, name, email, provider, model, verified, client, token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(a.id, a.kind, a.name, a.email, a.provider, a.model, a.verified ? 1 : 0, a.client, a.token, Date.now());
    return this.accountById(a.id)!;
  }

  accountByToken(token: string): Account | null {
    const r = this.sql.prepare('SELECT * FROM accounts WHERE token = ?').get(token) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  accountById(id: string): Account | null {
    const r = this.sql.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  accountByEmail(email: string): (Account & { token: string }) | null {
    const r = this.sql.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as Row | undefined;
    return r ? { ...toAccount(r), token: r.token as string } : null;
  }

  updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'provider' | 'model' | 'client'>>): void {
    const cur = this.accountById(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    this.sql
      .prepare('UPDATE accounts SET name = ?, provider = ?, model = ?, client = ? WHERE id = ?')
      .run(n.name, n.provider, n.model, n.client, id);
  }

  listAccounts(kind?: AccountKind): Account[] {
    const rows = kind
      ? this.sql.prepare('SELECT * FROM accounts WHERE kind = ? ORDER BY created_at DESC').all(kind)
      : this.sql.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    return (rows as Row[]).map(toAccount);
  }

  // games --------------------------------------------------------------------

  saveGame(state: GameState): void {
    // Events are stored separately; keep the snapshot small.
    const snapshot = JSON.stringify({ ...state, events: [] });
    this.sql
      .prepare(
        `INSERT INTO games (id, settings, phase, winner, player_count, created_at, started_at, ended_at, state)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET settings=excluded.settings, phase=excluded.phase, winner=excluded.winner,
           player_count=excluded.player_count, started_at=excluded.started_at, ended_at=excluded.ended_at, state=excluded.state`,
      )
      .run(
        state.id,
        JSON.stringify(state.settings),
        state.phase,
        state.winner,
        state.players.length,
        state.createdAt,
        state.startedAt,
        state.endedAt,
        snapshot,
      );
  }

  appendEvents(gameId: string, events: GameEvent[]): void {
    const st = this.sql.prepare(
      'INSERT OR IGNORE INTO events (game_id, seq, at, round, phase, type, vis, actor, text, data) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    for (const e of events) {
      st.run(gameId, e.seq, e.at, e.round, e.phase, e.type, JSON.stringify(e.vis), e.actor ?? null, e.text, JSON.stringify(e.data));
    }
  }

  loadEvents(gameId: string): GameEvent[] {
    const rows = this.sql.prepare('SELECT * FROM events WHERE game_id = ? ORDER BY seq').all(gameId) as Row[];
    return rows.map((r) => ({
      seq: r.seq as number,
      at: r.at as number,
      round: r.round as number,
      phase: r.phase as GameEvent['phase'],
      type: r.type as GameEvent['type'],
      vis: JSON.parse(r.vis as string),
      actor: (r.actor as string) ?? undefined,
      text: r.text as string,
      data: JSON.parse(r.data as string),
    }));
  }

  loadGameState(id: string): GameState | null {
    const r = this.sql.prepare('SELECT state FROM games WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const state = JSON.parse(r.state as string) as GameState;
    state.events = this.loadEvents(id);
    return state;
  }

  unfinishedGameIds(): string[] {
    return (this.sql.prepare("SELECT id FROM games WHERE phase != 'ended' ORDER BY created_at").all() as Row[]).map(
      (r) => r.id as string,
    );
  }

  listGames(limit = 100): Row[] {
    return this.sql
      .prepare(
        'SELECT id, settings, phase, winner, player_count, created_at, started_at, ended_at FROM games ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as Row[];
  }

  saveGamePlayers(state: GameState, accountIds: Record<string, string | undefined>): void {
    this.sql.prepare('DELETE FROM game_players WHERE game_id = ?').run(state.id);
    const st = this.sql.prepare(
      `INSERT INTO game_players (game_id, player_id, account_id, name, public_name, kind, provider, model, verified, role, team,
        survived, won, death_round, death_cause) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of state.players) {
      const team = p.role === 'murderer' ? 'mafia' : p.role ? 'town' : null;
      const won = state.winner && state.winner !== 'draw' ? (team === state.winner ? 1 : 0) : null;
      st.run(
        state.id,
        p.id,
        accountIds[p.id] ?? p.accountId ?? null,
        p.name,
        p.publicName,
        p.kind,
        p.provider ?? null,
        p.model ?? null,
        p.verified ? 1 : 0,
        p.role,
        team,
        state.phase === 'ended' ? (p.alive ? 1 : 0) : null,
        won,
        p.death?.round ?? null,
        p.death?.cause ?? null,
      );
    }
  }

  lastGameIdFor(accountId: string): string | null {
    const r = this.sql
      .prepare(
        `SELECT gp.game_id FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.account_id = ? ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(accountId) as Row | undefined;
    return r ? (r.game_id as string) : null;
  }

  // notes & reports ------------------------------------------------------------

  latestNotes(modelKey: string): { content: string; createdAt: number } | null {
    const r = this.sql
      .prepare('SELECT content, created_at FROM notes WHERE model_key = ? ORDER BY id DESC LIMIT 1')
      .get(modelKey) as Row | undefined;
    return r ? { content: r.content as string, createdAt: r.created_at as number } : null;
  }

  allLatestNotes(): { modelKey: string; content: string; createdAt: number }[] {
    const rows = this.sql
      .prepare(
        `SELECT n.model_key, n.content, n.created_at FROM notes n
         JOIN (SELECT model_key, MAX(id) AS mid FROM notes GROUP BY model_key) m ON n.id = m.mid ORDER BY n.model_key`,
      )
      .all() as Row[];
    return rows.map((r) => ({ modelKey: r.model_key as string, content: r.content as string, createdAt: r.created_at as number }));
  }

  notesHistory(modelKey: string): { content: string; gameId: string | null; createdAt: number }[] {
    return (
      this.sql.prepare('SELECT content, game_id, created_at FROM notes WHERE model_key = ? ORDER BY id DESC').all(modelKey) as Row[]
    ).map((r) => ({ content: r.content as string, gameId: (r.game_id as string) ?? null, createdAt: r.created_at as number }));
  }

  saveNotes(modelKey: string, accountId: string, gameId: string | null, content: string): void {
    this.sql
      .prepare('INSERT INTO notes (model_key, account_id, game_id, content, created_at) VALUES (?,?,?,?,?)')
      .run(modelKey, accountId, gameId, content, Date.now());
  }

  saveReport(r: { gameId: string; playerId: string; accountId: string | null; model: string | null; summary: string; lessons: string }): void {
    this.sql
      .prepare(
        `INSERT INTO reports (game_id, player_id, account_id, model, summary, lessons, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(game_id, player_id) DO UPDATE SET summary=excluded.summary, lessons=excluded.lessons, created_at=excluded.created_at`,
      )
      .run(r.gameId, r.playerId, r.accountId, r.model, r.summary, r.lessons, Date.now());
  }

  reports(gameId?: string): Row[] {
    return gameId
      ? (this.sql.prepare('SELECT * FROM reports WHERE game_id = ? ORDER BY created_at').all(gameId) as Row[])
      : (this.sql.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200').all() as Row[]);
  }

  // usage & audit ----------------------------------------------------------------

  addUsage(u: Usage): void {
    this.sql
      .prepare(
        `INSERT INTO usage (game_id, account_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, duration_ms, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        u.gameId,
        u.accountId,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.costUsd,
        u.durationMs,
        u.source,
        Date.now(),
      );
  }

  audit(gameId: string | null, accountId: string | null, kind: string, detail: string): void {
    this.sql
      .prepare('INSERT INTO audit (game_id, account_id, kind, detail, created_at) VALUES (?,?,?,?,?)')
      .run(gameId, accountId, kind, detail.slice(0, 4000), Date.now());
  }

  auditLog(gameId?: string): Row[] {
    return gameId
      ? (this.sql.prepare('SELECT * FROM audit WHERE game_id = ? ORDER BY id').all(gameId) as Row[])
      : (this.sql.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all() as Row[]);
  }
}
