import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Game, GameError, botDecide, type GameEvent, type GameSettings, type PlayerKind } from '@palermo/engine';
import type { Account, Db } from './db.ts';

export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export interface WaitOptions {
  /** Max seconds to wait before returning (even with nothing new). */
  maxWaitSec: number;
  /** Return once at least this many new chat messages arrived. */
  minMessages: number;
  /** Return immediately when someone mentions you by name. */
  wakeOnMention: boolean;
}

interface Waiter {
  playerId: string;
  opts: WaitOptions;
  resolve: (events: GameEvent[]) => void;
  timer: NodeJS.Timeout;
}

interface Live {
  game: Game;
  waiters: Set<Waiter>;
  /** playerId -> last event seq delivered through wait_for_events / get_new_events. */
  cursors: Map<string, number>;
  botTimers: Map<string, NodeJS.Timeout>;
  /** `${playerId}:${phase}${round}` -> messages said by a bot in this phase. */
  botSaid: Map<string, number>;
}

const CHATTY = new Set(['chat', 'team_chat', 'vote', 'thought', 'player_ready', 'player_joined', 'player_left']);

export interface ManagerOptions {
  botDelayMs?: [number, number];
  tickMs?: number;
}

/**
 * Owns all live games. Every state change goes through apply(), which persists new events, wakes waiting
 * agents, notifies web subscribers and lets scripted bots react.
 */
export class GameManager extends EventEmitter {
  private live = new Map<string, Live>();
  private tickTimer: NodeJS.Timeout | null = null;
  private botDelay: [number, number];

  constructor(private db: Db, opts: ManagerOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.botDelay = opts.botDelayMs ?? [700, 2500];
    for (const id of db.unfinishedGameIds()) {
      const state = db.loadGameState(id);
      if (state) this.live.set(id, this.wrap(Game.fromState(state)));
    }
    this.tickTimer = setInterval(() => this.tickAll(), opts.tickMs ?? 1000);
    this.tickTimer.unref();
  }

  close(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const l of this.live.values()) {
      for (const w of l.waiters) clearTimeout(w.timer);
      for (const t of l.botTimers.values()) clearTimeout(t);
    }
  }

  private wrap(game: Game): Live {
    return { game, waiters: new Set(), cursors: new Map(), botTimers: new Map(), botSaid: new Map() };
  }

  // ------------------------------------------------------------------- access

  get(id: string): Game | null {
    const l = this.live.get(id);
    if (l) return l.game;
    const state = this.db.loadGameState(id);
    return state ? Game.fromState(state) : null;
  }

  /** A game currently held in memory (running, lobby, or recently finished). */
  liveGame(id: string): Game | null {
    return this.live.get(id)?.game ?? null;
  }

  mustLive(id: string): Live {
    const l = this.live.get(id);
    if (!l) {
      const g = this.get(id);
      if (g?.state.phase === 'ended') throw new GameError('That game is over.');
      throw new GameError(`Unknown game "${id}".`);
    }
    return l;
  }

  liveGames(): Game[] {
    return [...this.live.values()].map((l) => l.game);
  }

  /** Player id of an account in a game. */
  playerIdFor(gameId: string, accountId: string): string | null {
    const g = this.get(gameId);
    return g?.state.players.find((p) => p.accountId === accountId)?.id ?? null;
  }

  /** The live (not ended) game an account is seated in, if any. */
  currentGameFor(accountId: string): Game | null {
    let ended: Game | null = null;
    for (const l of this.live.values()) {
      if (!l.game.state.players.some((p) => p.accountId === accountId)) continue;
      if (l.game.state.phase !== 'ended') return l.game;
      if (!ended || (l.game.state.endedAt ?? 0) > (ended.state.endedAt ?? 0)) ended = l.game;
    }
    return ended;
  }

  // ------------------------------------------------------------------- mutations

  create(settings: Partial<GameSettings>): Game {
    const id = newId('g', 4);
    const game = new Game(id, settings);
    this.live.set(id, this.wrap(game));
    this.db.saveGame(game.state);
    this.emit('games');
    return game;
  }

  /** Run a mutation against a live game and propagate its effects. */
  apply(gameId: string, fn: (g: Game) => GameEvent[]): GameEvent[] {
    const l = this.mustLive(gameId);
    const events = fn(l.game);
    this.afterChange(l, events);
    return events;
  }

  private afterChange(l: Live, events: GameEvent[]): void {
    const g = l.game;
    if (g.state.phase === 'lobby' && g.settings.autoStart) {
      const seatsOk = !g.settings.seats || g.state.players.length >= g.settings.seats;
      if (seatsOk && g.canStart().ok) events.push(...g.start());
    }
    if (!events.length) return;
    this.db.appendEvents(g.state.id, events);
    this.db.saveGame(g.state);
    if (g.state.phase !== 'lobby') this.db.saveGamePlayers(g.state, {});
    this.wake(l);
    this.emit('change', g.state.id, events);
    if (events.some((e) => ['player_joined', 'player_left', 'game_started', 'game_ended'].includes(e.type))) this.emit('games');
    if (g.state.phase === 'ended') {
      for (const t of l.botTimers.values()) clearTimeout(t);
      // Keep it live briefly so agents can still fetch the final events, then drop from memory.
      setTimeout(() => this.live.delete(g.state.id), 10 * 60_000).unref();
    } else {
      this.scheduleBots(l);
    }
  }

  join(gameId: string, input: { accountId?: string; name: string; kind: PlayerKind; provider?: string | null; model?: string | null; verified?: boolean }): string {
    const l = this.mustLive(gameId);
    if (input.accountId) {
      const existing = l.game.state.players.find((p) => p.accountId === input.accountId);
      if (existing) return existing.id;
    }
    const id = newId('p', 4);
    this.apply(gameId, (g) =>
      g.addPlayer({
        id,
        name: input.name,
        kind: input.kind,
        provider: input.provider ?? undefined,
        model: input.model ?? undefined,
        verified: input.verified,
        accountId: input.accountId,
      }),
    );
    return id;
  }

  joinAccount(gameId: string, account: Account, displayName?: string): string {
    return this.join(gameId, {
      accountId: account.id,
      name: displayName || account.name,
      kind: account.kind === 'ai' ? 'ai' : 'human',
      provider: account.provider,
      model: account.model,
      verified: account.verified,
    });
  }

  /** Correct the model of an account's seats in live games (stats read it from the seat). */
  updateAccountModel(accountId: string, model: string): void {
    for (const l of this.live.values()) {
      const p = l.game.state.players.find((x) => x.accountId === accountId);
      if (!p || p.model === model) continue;
      p.model = model;
      this.db.saveGame(l.game.state);
      if (l.game.state.phase !== 'lobby') this.db.saveGamePlayers(l.game.state, {});
    }
  }

  addBot(gameId: string, name?: string): string {
    const l = this.mustLive(gameId);
    const n = name || `Bot-${l.game.state.players.filter((p) => p.kind === 'bot').length + 1}`;
    const id = this.join(gameId, { name: n, kind: 'bot', provider: 'script', model: 'random-bot', verified: true });
    this.apply(gameId, (g) => g.setReady(id, true));
    return id;
  }

  private tickAll(): void {
    for (const l of this.live.values()) {
      if (l.game.state.phase === 'night' || l.game.state.phase === 'day') {
        try {
          const ev = l.game.tick();
          if (ev.length) this.afterChange(l, ev);
        } catch (e) {
          console.error('tick failed', e);
        }
      }
    }
  }

  // ------------------------------------------------------------------- bots

  private scheduleBots(l: Live): void {
    const g = l.game;
    for (const p of g.state.players) {
      if (p.kind !== 'bot' || !p.alive || l.botTimers.has(p.id)) continue;
      const [lo, hi] = this.botDelay;
      const t = setTimeout(() => {
        l.botTimers.delete(p.id);
        this.botAct(l, p.id);
      }, lo + Math.random() * (hi - lo));
      t.unref();
      l.botTimers.set(p.id, t);
    }
  }

  private botAct(l: Live, playerId: string): void {
    const g = l.game;
    if (g.state.phase === 'ended' || !this.live.has(g.state.id)) return;
    const key = `${playerId}:${g.state.phase}${g.state.round}`;
    const said = l.botSaid.get(key) ?? 0;
    const d = botDecide(g.view(playerId), said);
    if (!d) return;
    try {
      this.apply(g.state.id, (game) => {
        switch (d.type) {
          case 'ready':
            return game.setReady(playerId, true);
          case 'night_action':
            return game.nightAction(playerId, d.target, d.thought);
          case 'vote':
            return game.vote(playerId, d.target, d.thought);
          case 'say':
            l.botSaid.set(key, said + 1);
            return game.say(playerId, d.message, d.thought);
        }
      });
    } catch (e) {
      if (!(e instanceof GameError)) console.error('bot failed', e);
    }
  }

  // ------------------------------------------------------------------- waiting (for AI agents)

  /** Events for a player since its cursor, without the player's own chatter. Advances the cursor. */
  takeNewEvents(gameId: string, playerId: string, advance = true): GameEvent[] {
    const l = this.live.get(gameId);
    const g = l?.game ?? this.get(gameId);
    if (!g) return [];
    const since = l?.cursors.get(playerId) ?? 0;
    const events = g.eventsFor(playerId, since).filter((e) => !(e.actor === playerId && CHATTY.has(e.type)));
    if (advance && l) l.cursors.set(playerId, g.state.events.length);
    return events;
  }

  private shouldWake(g: Game, w: Waiter, events: GameEvent[]): boolean {
    if (!events.length) return false;
    if (g.state.phase === 'ended') return true;
    const me = g.player(w.playerId);
    // Dead players can only watch: waking them for every message just burns tokens. Wake them at the end.
    if (me && !me.alive && g.state.phase !== 'lobby') return false;
    let messages = 0;
    for (const e of events) {
      if (!CHATTY.has(e.type)) return true; // phase changes, results, deaths, role info...
      if (e.type === 'chat' || e.type === 'team_chat' || e.type === 'vote') messages++;
      if (w.opts.wakeOnMention && me && (e.type === 'chat' || e.type === 'team_chat')) {
        const msg = String(e.data.message ?? '');
        const re = new RegExp(`(^|[^\\p{L}])@?${escapeRe(me.publicName)}([^\\p{L}]|$)`, 'iu');
        if (re.test(msg)) return true;
      }
    }
    return messages >= w.opts.minMessages;
  }

  private wake(l: Live): void {
    for (const w of [...l.waiters]) {
      const pending = this.takeNewEvents(l.game.state.id, w.playerId, false);
      if (this.shouldWake(l.game, w, pending)) this.finishWait(l, w);
    }
  }

  private finishWait(l: Live, w: Waiter): void {
    clearTimeout(w.timer);
    l.waiters.delete(w);
    w.resolve(this.takeNewEvents(l.game.state.id, w.playerId, true));
  }

  waitForEvents(gameId: string, playerId: string, opts: WaitOptions): Promise<GameEvent[]> {
    const l = this.live.get(gameId);
    if (!l) return Promise.resolve(this.takeNewEvents(gameId, playerId));
    const me = l.game.player(playerId);
    if (me && !me.alive) opts = { ...opts, maxWaitSec: Math.max(opts.maxWaitSec, 110) };
    // Only one outstanding wait per player.
    for (const w of [...l.waiters]) if (w.playerId === playerId) this.finishWait(l, w);
    return new Promise((resolve) => {
      const w: Waiter = {
        playerId,
        opts,
        resolve,
        timer: setTimeout(() => this.finishWait(l, w), Math.max(1, opts.maxWaitSec) * 1000),
      };
      l.waiters.add(w);
      const pending = this.takeNewEvents(gameId, playerId, false);
      if (this.shouldWake(l.game, w, pending)) this.finishWait(l, w);
    });
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
