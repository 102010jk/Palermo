import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Game, GameSettings } from '@palermo/engine';
import type { Auth } from './auth.ts';
import { newId, type GameManager } from './manager.ts';

/**
 * The AI waiting list. The game master picks models on the "AI players" page; the agent launcher on the PC
 * (`agents.bat`, runner --pool) polls this pool, gets a seat assignment as soon as a lobby has a free seat and
 * starts the CLI for it. The launcher also tells the pool which models it can run (the catalog).
 */

export type PoolProvider = 'claude' | 'codex' | 'agy' | 'gemini' | 'bot';

export interface CatalogEntry {
  provider: PoolProvider;
  model: string;
  label: string;
}

export interface Pick {
  id: string;
  provider: PoolProvider;
  model: string;
  label: string;
  name: string;
  /** After a game, wait for the next lobby again. */
  repeat: boolean;
  status: 'waiting' | 'joining' | 'playing' | 'error';
  gameId?: string;
  accountId?: string;
  error?: string;
  since: number;
  games: number;
}

export interface Assignment {
  pickId: string;
  gameId: string;
  token: string;
  accountId: string;
  name: string;
  provider: PoolProvider;
  model: string;
  /** Back into a seat it already has (after a launcher or server restart): continue the game, don't join. */
  resume?: boolean;
}

const PROVIDER_NAME: Record<PoolProvider, string> = { claude: 'anthropic', codex: 'openai', agy: 'google', gemini: 'google', bot: 'script' };
const LAUNCHER_TIMEOUT_MS = 30_000;
/** An assigned agent that has not sat down by then (CLI failed to start…) gives the seat back. */
const JOIN_TIMEOUT_MS = 5 * 60_000;

/** A short seat name from a model label: "Gemini 3.8 Flash (High)" -> "Flash 3.8 High", "Claude Sonnet 5" -> "Sonnet 5". */
export function shortName(label: string): string {
  let n = label
    .replace(/\((high|medium|low)\)/gi, '$1')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  n = n.replace(/^(claude|gemini) /i, '');
  n = n.replace(/^(\d[\d.]*) (\S+)/, '$2 $1');
  return n;
}

export interface Series {
  id: string;
  label: string;
  total: number;
  gameIds: string[];
  settings: Partial<GameSettings>;
  active: boolean;
  createdAt: number;
  stoppedReason?: string;
}

export class AgentPool {
  picks: Pick[] = [];
  series: Series[] = [];
  catalog: CatalogEntry[] = [];
  launcher: { host: string; lastSeen: number } | null = null;

  constructor(
    private manager: GameManager,
    private auth: Auth,
    private file: string | null,
    private tokenOf: (accountId: string) => string | null = () => null,
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        this.catalog = saved.catalog ?? [];
        this.series = saved.series ?? [];
        this.picks = (saved.picks ?? []).map((p: Pick) => {
          // Players of an unfinished game keep their seat: the launcher puts them back (resume).
          const game = p.gameId ? this.manager.liveGame(p.gameId) : null;
          if (p.status === 'playing' && game && game.state.phase !== 'ended') return { ...p, since: 0 };
          return { ...p, status: p.status === 'error' ? 'error' : 'waiting', gameId: undefined, accountId: undefined };
        });
      } catch {
        // start empty
      }
    }
  }

  // ---------------------------------------------------------------- series

  /** "Play N games in a row": the next lobby opens as soon as the previous game is over. */
  startSeries(settings: Partial<GameSettings>, total: number): Series {
    const id = newId('s', 3);
    const label = `${String(settings.mode ?? 'series').slice(0, 30)} ×${total}`;
    const series: Series = { id, label, total: Math.max(1, Math.min(1000, total)), gameIds: [], settings: { ...settings, series: id }, active: true, createdAt: Date.now() };
    this.series.push(series);
    this.nextGame(series);
    return series;
  }

  stopSeries(id: string, reason = 'stopped by the host'): void {
    const x = this.series.find((s) => s.id === id);
    if (!x || !x.active) return;
    x.active = false;
    x.stoppedReason = reason;
    // An empty lobby of the series would only attract players.
    const last = x.gameIds.length ? this.manager.liveGame(x.gameIds[x.gameIds.length - 1]) : null;
    if (last && last.state.phase === 'lobby') this.manager.apply(last.state.id, (g) => g.abort('The series was stopped.'));
    this.save();
  }

  private finishedGames(x: Series): number {
    return x.gameIds.filter((id) => {
      const g = this.manager.get(id);
      return g?.state.phase === 'ended' && !g.state.aborted;
    }).length;
  }

  private nextGame(x: Series): void {
    const g = this.manager.create(x.settings);
    x.gameIds.push(g.state.id);
    this.save();
  }

  /** Opens the next game of every running series whose previous game is over. */
  private advanceSeries(): void {
    for (const x of this.series) {
      if (!x.active) continue;
      const last = x.gameIds.length ? this.manager.get(x.gameIds[x.gameIds.length - 1]) : null;
      if (last && last.state.phase !== 'ended') continue;
      if (last?.state.aborted) {
        this.stopSeries(x.id, 'a game of the series was stopped');
        continue;
      }
      if (x.gameIds.length >= x.total) {
        x.active = false;
        this.save();
        continue;
      }
      this.nextGame(x);
    }
  }

  /**
   * Called every few seconds. When the launcher disappears (agents.bat closed, PC asleep) while its players sit in a
   * running game, the game pauses until they are back, instead of running on without them.
   */
  watch(): void {
    this.advanceSeries();
    if (this.online || !this.launcher) return;
    for (const p of this.picks) {
      if (p.status !== 'playing' || !p.gameId || !p.accountId) continue;
      const game = this.manager.liveGame(p.gameId);
      if (!game || (game.state.phase !== 'night' && game.state.phase !== 'day')) continue;
      if (game.state.pausedBy?.includes(p.accountId)) continue;
      const accountId = p.accountId;
      this.manager.apply(p.gameId, (g) => g.pause('the AI launcher (agents.bat) is offline', accountId));
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify({ picks: this.picks, catalog: this.catalog, series: this.series }, null, 2));
    } catch {
      // not fatal
    }
  }

  get online(): boolean {
    return !!this.launcher && Date.now() - this.launcher.lastSeen < LAUNCHER_TIMEOUT_MS;
  }

  status() {
    return {
      online: this.online,
      launcher: this.launcher,
      catalog: this.catalog,
      picks: this.picks,
      lobbies: this.openLobbies().map((g) => this.lobbyInfo(g)),
      series: this.series.slice(-10).map((x) => ({ ...x, done: this.finishedGames(x) })),
    };
  }

  add(input: { provider: PoolProvider; model: string; label?: string; name?: string; repeat?: boolean }): Pick {
    const label = (input.label || input.model).slice(0, 60);
    const base = (input.name || shortName(label)).replace(/[^\w .-]/g, '').trim().slice(0, 24) || 'Agent';
    const pick: Pick = {
      id: newId('p', 4),
      provider: input.provider,
      model: input.model.slice(0, 80),
      label,
      name: this.uniqueName(base),
      repeat: input.repeat !== false,
      status: 'waiting',
      since: Date.now(),
      games: 0,
    };
    this.picks.push(pick);
    this.save();
    return pick;
  }

  update(id: string, patch: { name?: string; repeat?: boolean; retry?: boolean }): void {
    const p = this.picks.find((x) => x.id === id);
    if (!p) return;
    if (typeof patch.repeat === 'boolean') p.repeat = patch.repeat;
    if (patch.name && p.status === 'waiting') {
      const name = patch.name.replace(/[^\w .-]/g, '').trim().slice(0, 24);
      if (name) p.name = this.uniqueName(name, p.id);
    }
    if (patch.retry && p.status === 'error') Object.assign(p, { status: 'waiting', error: undefined, since: Date.now() });
    this.save();
  }

  remove(id: string): void {
    const p = this.picks.find((x) => x.id === id);
    if (p) this.leaveLobby(p);
    this.picks = this.picks.filter((x) => x.id !== id);
    this.save();
  }

  /** Frees the seat of a pick that is still sitting in a lobby (the game has not started yet). */
  private leaveLobby(p: Pick): void {
    const game = p.gameId ? this.manager.liveGame(p.gameId) : null;
    const seat = game?.state.players.find((x) => x.accountId === p.accountId);
    if (game && seat && game.state.phase === 'lobby') {
      try {
        this.manager.apply(game.state.id, (g) => g.removePlayer(seat.id));
      } catch {
        // already gone
      }
    }
  }

  private uniqueName(base: string, selfId?: string): string {
    const taken = new Set(this.picks.filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  private openLobbies(): Game[] {
    return this.manager
      .liveGames()
      .filter((g) => g.state.phase === 'lobby' && !g.state.aborted && g.settings.aiPool !== false)
      .sort((a, b) => a.state.createdAt - b.state.createdAt);
  }

  /** Seats still free in a lobby, counting agents that are on their way. 0 seats = no limit. */
  private freeSeats(g: Game): number {
    if (!g.settings.seats) return Infinity;
    const seated = new Set(g.state.players.map((p) => p.accountId));
    const coming = this.picks.filter((p) => p.gameId === g.state.id && p.status === 'joining' && !seated.has(p.accountId)).length;
    return g.settings.seats - g.state.players.length - coming;
  }

  private lobbyInfo(g: Game) {
    return { id: g.state.id, mode: g.settings.mode, players: g.state.players.length, seats: g.settings.seats, free: Math.max(0, Math.min(99, this.freeSeats(g))) };
  }

  /**
   * Launcher heartbeat. `running` are the picks it is still playing; anything else marked as playing is over.
   * Returns new seat assignments for it to launch.
   */
  hello(input: { host: string; catalog?: CatalogEntry[]; running?: string[] }) {
    this.launcher = { host: String(input.host ?? '?').slice(0, 60), lastSeen: Date.now() };
    if (Array.isArray(input.catalog) && input.catalog.length) this.catalog = input.catalog.slice(0, 300);
    const running = new Set(input.running ?? []);
    const now = Date.now();
    const resumes: Assignment[] = [];
    for (const p of this.picks) {
      if (p.status !== 'joining' && p.status !== 'playing') continue;
      const game = p.gameId ? this.manager.get(p.gameId) : null;
      const seated = !!game?.state.players.some((x) => x.accountId === p.accountId);
      if (p.status === 'joining' && seated) p.status = 'playing';
      if (!running.has(p.id) && now - p.since > LAUNCHER_TIMEOUT_MS) {
        // The launcher no longer runs it (restarted, crashed or was closed).
        const token = p.accountId ? this.tokenOf(p.accountId) : null;
        if (p.status === 'playing' && game && game.state.phase !== 'ended' && token) {
          p.since = now;
          resumes.push({ pickId: p.id, gameId: p.gameId!, token, accountId: p.accountId!, name: p.name, provider: p.provider, model: p.model, resume: true });
        } else {
          this.finish(p.id, p.gameId);
        }
      } else if (p.status === 'joining' && (!game || game.state.phase !== 'lobby')) {
        // The game started without it: not its fault, it waits for the next lobby (the launcher stops the CLI).
        Object.assign(p, { status: 'waiting', gameId: undefined, accountId: undefined, since: now });
      } else if (p.status === 'joining' && now - p.since > JOIN_TIMEOUT_MS) {
        this.leaveLobby(p);
        Object.assign(p, { status: 'error', error: 'did not sit down within 5 minutes (see agents.bat)', gameId: undefined, accountId: undefined, since: now });
      }
    }
    // Agents the launcher still runs but that no longer have a seat (removed, or the game started without them).
    const active = new Set(this.picks.filter((p) => p.status === 'joining' || p.status === 'playing').map((p) => p.id));
    const cancel = [...running].filter((id) => !active.has(id));

    const assignments: Assignment[] = [...resumes];
    for (const g of this.openLobbies()) {
      let free = this.freeSeats(g);
      for (const p of this.picks) {
        if (free <= 0) break;
        if (p.status !== 'waiting' || running.has(p.id)) continue;
        const { token, account } = this.auth.createAgent({ name: p.name, provider: PROVIDER_NAME[p.provider], model: p.model, verified: true });
        Object.assign(p, { status: 'joining', gameId: g.state.id, accountId: account.id, since: now, error: undefined });
        assignments.push({ pickId: p.id, gameId: g.state.id, token, accountId: account.id, name: p.name, provider: p.provider, model: p.model });
        free--;
      }
    }
    // A readable summary for the launcher window.
    const closed = this.manager
      .liveGames()
      .filter((g) => g.state.phase === 'lobby' && !g.state.aborted && g.settings.aiPool === false)
      .map((g) => g.state.id);
    this.save();
    return {
      assignments,
      cancel,
      waiting: this.picks.filter((p) => p.status === 'waiting').map((p) => p.name),
      busy: this.picks.filter((p) => p.status === 'joining' || p.status === 'playing').map((p) => `${p.name} (${p.gameId})`),
      errors: this.picks.filter((p) => p.status === 'error').map((p) => `${p.name}: ${p.error}`),
      lobbies: this.openLobbies().map((g) => this.lobbyInfo(g)),
      closedLobbies: closed,
    };
  }

  /**
   * The launcher reports that an agent stopped (game over, or it could not play). `gameId` guards against a late
   * report for a pick that has already moved on to another game.
   */
  finish(pickId: string, gameId?: string, error?: string): void {
    const p = this.picks.find((x) => x.id === pickId);
    if (!p || (gameId && p.gameId && p.gameId !== gameId)) return;
    if (p.status !== 'joining' && p.status !== 'playing') return;
    const game = p.gameId ? this.manager.get(p.gameId) : null;
    const sat = !!game?.state.players.some((x) => x.accountId === p.accountId);
    if (sat && game?.state.phase === 'ended' && !game.state.aborted && !error) p.games++;
    if (!error) this.leaveLobby(p);
    if (error) Object.assign(p, { status: 'error', error: error.slice(0, 500) });
    else if (p.repeat) p.status = 'waiting';
    else this.picks = this.picks.filter((x) => x.id !== pickId);
    Object.assign(p, { gameId: undefined, accountId: undefined, since: Date.now() });
    this.save();
  }
}
