import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Game } from '@palermo/engine';
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

export class AgentPool {
  picks: Pick[] = [];
  catalog: CatalogEntry[] = [];
  launcher: { host: string; lastSeen: number } | null = null;

  constructor(
    private manager: GameManager,
    private auth: Auth,
    private file: string | null,
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        this.catalog = saved.catalog ?? [];
        // Nothing is running right after a restart; everyone waits again.
        this.picks = (saved.picks ?? []).map((p: Pick) => ({ ...p, status: p.status === 'error' ? 'error' : 'waiting', gameId: undefined, accountId: undefined }));
      } catch {
        // start empty
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify({ picks: this.picks, catalog: this.catalog }, null, 2));
    } catch {
      // not fatal
    }
  }

  get online(): boolean {
    return !!this.launcher && Date.now() - this.launcher.lastSeen < LAUNCHER_TIMEOUT_MS;
  }

  status() {
    return { online: this.online, launcher: this.launcher, catalog: this.catalog, picks: this.picks, lobbies: this.openLobbies().map((g) => this.lobbyInfo(g)) };
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
    this.picks = this.picks.filter((p) => p.id !== id);
    this.save();
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
  hello(input: { host: string; catalog?: CatalogEntry[]; running?: string[] }): { assignments: Assignment[] } {
    this.launcher = { host: String(input.host ?? '?').slice(0, 60), lastSeen: Date.now() };
    if (Array.isArray(input.catalog) && input.catalog.length) this.catalog = input.catalog.slice(0, 300);
    const running = new Set(input.running ?? []);
    const now = Date.now();
    for (const p of this.picks) {
      if (p.status !== 'joining' && p.status !== 'playing') continue;
      const game = p.gameId ? this.manager.get(p.gameId) : null;
      const seated = !!game?.state.players.some((x) => x.accountId === p.accountId);
      if (p.status === 'joining' && seated) p.status = 'playing';
      const lost = !running.has(p.id) && now - p.since > LAUNCHER_TIMEOUT_MS;
      const neverCame = p.status === 'joining' && (now - p.since > JOIN_TIMEOUT_MS || !game || game.state.phase !== 'lobby');
      if (lost || neverCame) this.finish(p.id, neverCame && !lost ? 'did not join in time' : undefined);
    }

    const assignments: Assignment[] = [];
    for (const g of this.openLobbies()) {
      let free = this.freeSeats(g);
      for (const p of this.picks) {
        if (free <= 0) break;
        if (p.status !== 'waiting') continue;
        const { token, account } = this.auth.createAgent({ name: p.name, provider: PROVIDER_NAME[p.provider], model: p.model, verified: true });
        Object.assign(p, { status: 'joining', gameId: g.state.id, accountId: account.id, since: now, error: undefined });
        assignments.push({ pickId: p.id, gameId: g.state.id, token, accountId: account.id, name: p.name, provider: p.provider, model: p.model });
        free--;
      }
    }
    if (assignments.length) this.save();
    return { assignments };
  }

  /** The launcher reports that an agent stopped (game over, or it could not play). */
  finish(pickId: string, error?: string): void {
    const p = this.picks.find((x) => x.id === pickId);
    if (!p) return;
    const game = p.gameId ? this.manager.get(p.gameId) : null;
    const sat = !!game?.state.players.some((x) => x.accountId === p.accountId);
    if (sat && game?.state.phase === 'ended' && !game.state.aborted && !error) p.games++;
    if (error) Object.assign(p, { status: 'error', error: error.slice(0, 500) });
    else if (p.repeat) p.status = 'waiting';
    else this.picks = this.picks.filter((x) => x.id !== pickId);
    Object.assign(p, { gameId: undefined, accountId: undefined, since: Date.now() });
    this.save();
  }
}
