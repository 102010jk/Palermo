import { DEFAULT_SETTINGS, ROLES, apparentRole, isCrazy, rolesFor, teamOf } from './roles.ts';
import { pick, shuffle } from './rng.ts';
import type {
  EventType,
  GameEvent,
  GameSettings,
  GameState,
  NightActionKind,
  Phase,
  Player,
  PlayerInput,
  PlayerView,
  PublicPlayer,
  RequiredAction,
  RoleId,
  Team,
  Visibility,
  Winner,
} from './types.ts';

/** One night action as a trip to a house (for resolution, stats and the night animation). */
export interface NightVisit {
  from: string;
  to: string;
  kind: NightActionKind;
  /** Stayed home: self-targeted, or a crazy role (whose actions do nothing). */
  home: boolean;
  crazy: boolean;
  /** Walked into a trap: the action failed. */
  caught: boolean;
}

export class GameError extends Error {}

/** Names used as aliases in anonymous games. */
export const TOWN_NAMES = [
  'Salvatore', 'Lucia', 'Giuseppe', 'Rosalia', 'Vito', 'Carmela', 'Tommaso', 'Giulia', 'Enzo', 'Francesca',
  'Nino', 'Serafina', 'Rocco', 'Concetta', 'Aldo', 'Pina', 'Marco', 'Teresa', 'Paolo', 'Agata',
];

export const SKIP = 'skip';
/** Night target meaning "stay home tonight" (murderers may pass). */
export const PASS = 'pass';
/** The vote deadline never stretches beyond this, however much people keep talking. */
export const VOTE_DEADLINE_CAP_SEC = 300;
/** Visual games: a day lasts at least this long, so people can follow and join in. */
export const VISUAL_MIN_DAY_SEC = 45;
/** Visual games: a night lasts at least this long (plus the time to play out the visits). */
export const VISUAL_MIN_NIGHT_SEC = 12;
/** Visual games: how long one night visit takes to play out in the god view (walk there, act, walk back). */
export const VISUAL_VISIT_MS = 5000;

/** How long a chat message stays on screen before the next one (visual games). */
export function readingTimeMs(text: string): number {
  return Math.min(12_000, 2_500 + 45 * text.length);
}

export interface GameOptions {
  seed?: number;
  now?: () => number;
}

/**
 * Authoritative Palermo game. Pure logic: no I/O, no timers. The server calls tick() to enforce deadlines.
 * Every mutating method returns the events it produced; invalid moves throw GameError with a message
 * written so an AI agent can understand and correct it.
 */
export class Game {
  state: GameState;
  private now: () => number;

  constructor(id: string, settings: Partial<GameSettings> = {}, opts: GameOptions = {}) {
    this.now = opts.now ?? Date.now;
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.state = {
      id,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      seed,
      rngState: seed,
      phase: 'lobby',
      round: 0,
      phaseStartedAt: null,
      phaseEndsAt: null,
      players: [],
      nightChoices: {},
      votes: {},
      lastProtected: {},
      selfProtectUsed: [],
      events: [],
      winner: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
    };
  }

  static fromState(state: GameState, opts: GameOptions = {}): Game {
    const g = new Game(state.id, state.settings, opts);
    g.state = state;
    return g;
  }

  // ---------------------------------------------------------------- helpers

  get settings(): GameSettings {
    return this.state.settings;
  }

  player(id: string): Player | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  mustPlayer(id: string): Player {
    const p = this.player(id);
    if (!p) throw new GameError('You are not a player in this game.');
    return p;
  }

  alive(): Player[] {
    return this.state.players.filter((p) => p.alive);
  }

  /** Resolve a target given by public name (case-insensitive) or id. */
  resolveTarget(ref: string): Player {
    const r = ref.trim().toLowerCase().replace(/^@/, '');
    const p =
      this.state.players.find((x) => x.id === ref) ??
      this.state.players.find((x) => x.publicName.toLowerCase() === r);
    if (!p) {
      throw new GameError(
        `Unknown player "${ref}". Valid names: ${this.state.players.map((x) => x.publicName).join(', ')}.`,
      );
    }
    return p;
  }

  private emit(
    type: EventType,
    vis: Visibility,
    text: string,
    data: Record<string, unknown> = {},
    actor?: string,
  ): GameEvent {
    const ev: GameEvent = {
      seq: this.state.events.length + 1,
      at: this.now(),
      round: this.state.round,
      phase: this.state.phase,
      type,
      vis,
      actor,
      text,
      data,
    };
    this.state.events.push(ev);
    return ev;
  }

  private emitThought(player: Player, thought: string | undefined, context: string): GameEvent[] {
    if (!thought || !thought.trim()) return [];
    return [
      this.emit('thought', { scope: 'admin' }, `${player.publicName} thinks (${context}): ${thought.trim()}`, {
        thought: thought.trim(),
        context,
      }, player.id),
    ];
  }

  canSee(ev: GameEvent, viewerId: string | null): boolean {
    if (viewerId === null) return true; // admin
    const vis = ev.vis;
    switch (vis.scope) {
      case 'public':
        return true;
      case 'admin':
        return false;
      case 'players':
        return vis.ids.includes(viewerId);
      case 'team': {
        const p = this.player(viewerId);
        return !!p?.role && teamOf(p.role) === vis.team;
      }
    }
  }

  /** Events visible to a viewer (null = admin) with seq > since. */
  eventsFor(viewerId: string | null, since = 0): GameEvent[] {
    // In anonymous games the lobby log would link real names to seats, so players only see it before the start.
    const hideLobby = viewerId !== null && this.settings.identityVisibility === 'anonymous' && this.state.phase !== 'lobby' && this.state.phase !== 'ended';
    return this.state.events.filter((e) => e.seq > since && !(hideLobby && e.phase === 'lobby') && this.canSee(e, viewerId));
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(input: PlayerInput): GameEvent[] {
    if (this.state.phase !== 'lobby') throw new GameError('The game has already started.');
    if (this.player(input.id)) throw new GameError('You already joined this game.');
    const name = input.name.trim().slice(0, 32);
    if (!name) throw new GameError('Name must not be empty.');
    if (name.toLowerCase() === SKIP || name.toLowerCase() === PASS) throw new GameError(`"${name}" is reserved.`);
    if (this.state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError(`The name "${name}" is already taken in this game.`);
    }
    const p: Player = {
      ...input,
      name,
      publicName: name,
      verified: !!input.verified,
      role: null,
      alive: true,
      ready: false,
    };
    this.state.players.push(p);
    return [this.emit('player_joined', { scope: 'public' }, `${name} joined the game.`, { playerId: p.id }, p.id)];
  }

  removePlayer(id: string): GameEvent[] {
    if (this.state.phase !== 'lobby') throw new GameError('Players cannot leave after the game started.');
    const p = this.mustPlayer(id);
    this.state.players = this.state.players.filter((x) => x.id !== id);
    return [this.emit('player_left', { scope: 'public' }, `${p.name} left the game.`, { playerId: id }, id)];
  }

  setReady(id: string, ready = true): GameEvent[] {
    if (this.state.phase !== 'lobby') throw new GameError('The game has already started.');
    const p = this.mustPlayer(id);
    if (p.ready === ready) return [];
    p.ready = ready;
    return [
      this.emit('player_ready', { scope: 'public' }, `${p.name} is ${ready ? 'ready' : 'not ready'}.`, { ready }, id),
    ];
  }

  canStart(force = false): { ok: boolean; reason?: string } {
    if (this.state.phase !== 'lobby') return { ok: false, reason: 'Game already started.' };
    const n = this.state.players.length;
    if (n < this.settings.minPlayers) return { ok: false, reason: `Need at least ${this.settings.minPlayers} players.` };
    if (!force && this.state.players.some((p) => !p.ready)) return { ok: false, reason: 'Not everyone is ready.' };
    try {
      rolesFor(this.settings, n);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    return { ok: true };
  }

  start(force = false): GameEvent[] {
    const check = this.canStart(force);
    if (!check.ok) throw new GameError(check.reason);
    const s = this.state;
    const out: GameEvent[] = [];

    const roles = shuffle(s, rolesFor(this.settings, s.players.length));
    s.players = shuffle(s, s.players); // random seating order
    if (this.settings.identityVisibility === 'anonymous') {
      const names = shuffle(s, TOWN_NAMES);
      s.players.forEach((p, i) => (p.publicName = names[i] ?? `Player ${i + 1}`));
    }
    s.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
    });
    s.startedAt = this.now();
    s.round = 1;

    out.push(
      this.emit(
        'game_started',
        { scope: 'public' },
        `The game begins with ${s.players.length} players: ${s.players.map((p) => p.publicName).join(', ')}. ` +
          (this.settings.announceRoles
            ? `Roles in play: ${summarizeRoles(roles.map(apparentRole))}.`
            : 'The role setup is secret: nobody knows how many of each role are in play.'),
        { players: s.players.map((p) => p.publicName), roles: this.settings.announceRoles ? countRoles(roles.map(apparentRole)) : undefined },
      ),
    );

    const lone = this.loneWolves();
    for (const p of s.players) {
      const shown = apparentRole(p.role!);
      const role = ROLES[shown];
      let text = `Your role: ${role.name}. ${role.description}`;
      const mates = this.knowsPartners(p) ? this.partnersOf(p).map((m) => m.publicName) : [];
      const mateList = this.knowsPartners(p) ? this.partnersOf(p).map((m) => `${m.publicName} (${ROLES[m.role!].name})`) : [];
      if (mateList.length) text += ` Your mafia partners: ${mateList.join(', ')}.`;
      if (shown === 'murderer' && lone) {
        text += ' This game the murderers work alone: you do not know the other murderers (if any) and there is no private murderer chat.';
      }
      if (shown === 'ventriloquist' && lone) {
        text += ' This game the mafia works alone: you do not know the murderers and there is no private night chat.';
      }
      out.push(this.emit('role_assigned', { scope: 'players', ids: [p.id] }, text, { role: shown, teammates: mates }, p.id));
    }
    // The truth (crazy roles) only for the game master.
    out.push(
      this.emit('notice', { scope: 'admin' }, 'Real roles (admin).', {
        kind: 'real_roles',
        roles: Object.fromEntries(s.players.map((p) => [p.publicName, p.role])),
      }),
    );
    out.push(...this.enterPhase(this.settings.startPhase));
    return out;
  }

  // ---------------------------------------------------------------- role helpers

  /** With a crazy murderer in play, the murderers do not know each other (otherwise the crazy one would stand out). */
  loneWolves(): boolean {
    return this.state.players.some((p) => p.role === 'crazy_murderer');
  }

  /** Mafia members (murderers, ventriloquist) who know (and can talk to) each other. */
  knowsPartners(p: Player): boolean {
    return !!p.role && !isCrazy(p.role) && teamOf(p.role) === 'mafia' && !this.loneWolves();
  }

  partnersOf(p: Player): Player[] {
    return this.knowsPartners(p) ? this.state.players.filter((m) => m.id !== p.id && this.knowsPartners(m)) : [];
  }

  /** The night action a player believes to have (crazy roles act like the role they believe in). */
  believedKind(p: Player): NightActionKind | null {
    return p.role ? ROLES[apparentRole(p.role)].nightAction : null;
  }

  // ---------------------------------------------------------------- visual pacing

  visual(): boolean {
    return this.settings.gameStyle === 'visual';
  }

  /** A chat message in `p`'s name. With `forgedBy` it was really written by the ventriloquist (only the god view knows). */
  private speak(p: Player, text: string, forgedBy?: string): GameEvent[] {
    const s = this.state;
    if (this.visual()) s.floorUntil = this.now() + readingTimeMs(text);
    const ev = this.emit('chat', { scope: 'public' }, `${p.publicName}: ${text}`, { message: text }, p.id);
    this.extendVoteDeadline();
    if (!forgedBy) return [ev];
    return [ev, this.emit('notice', { scope: 'admin' }, `Forged: ${this.player(forgedBy)?.publicName} spoke as ${p.publicName}.`, { kind: 'forged', by: forgedBy, as: p.id, chatSeq: ev.seq })];
  }

  /** Visual games: the next queued message gets the floor once the previous one has been read. */
  private releaseSpeech(): GameEvent[] {
    const s = this.state;
    if (s.phase !== 'day' || !s.speechQueue?.length || (s.floorUntil ?? 0) > this.now()) return [];
    while (s.speechQueue.length) {
      const next = s.speechQueue.shift()!;
      const p = this.player(next.playerId);
      if (p?.alive) return this.speak(p, next.text, next.forgedBy);
    }
    return [];
  }

  /**
   * Visual games: once every night action is in (or time is up), the visits are played out for the god view before
   * dawn. Actions are locked meanwhile; the night resolves at phaseEndsAt.
   */
  private planNight(): GameEvent[] {
    const s = this.state;
    if (s.nightPlanned) return [];
    s.nightPlanned = true;
    const visits = this.computeVisits();
    const walking = visits.filter((v) => !v.home).length;
    const minEnd = (s.phaseStartedAt ?? this.now()) + VISUAL_MIN_NIGHT_SEC * 1000;
    s.phaseEndsAt = Math.max(this.now() + 2_000 + walking * VISUAL_VISIT_MS, minEnd);
    return [this.emit('notice', { scope: 'admin' }, 'Night plan (admin).', { kind: 'night_plan', visits, until: s.phaseEndsAt })];
  }

  // ---------------------------------------------------------------- pause

  /**
   * Freeze the game (e.g. a usage limit ran out): deadlines stop until resume(). With `by` (an account id) the game
   * waits for that player: it resumes on its own once everyone it waits for checked in again.
   */
  pause(reason: string, by?: string): GameEvent[] {
    const s = this.state;
    if (s.phase === 'lobby' || s.phase === 'ended') return [];
    if (by) s.pausedBy = [...new Set([...(s.pausedBy ?? []), by])];
    if (s.pausedAt) return [];
    s.pausedAt = this.now();
    s.pauseReason = reason;
    return [this.emit('notice', { scope: 'public' }, `The game is paused: ${reason}. It continues when everyone is back.`, { kind: 'paused', reason })];
  }

  /** A player the game waits for is back; resumes when nobody is missing any more. */
  checkIn(by: string): GameEvent[] {
    const s = this.state;
    if (!s.pausedBy?.includes(by)) return [];
    s.pausedBy = s.pausedBy.filter((x) => x !== by);
    return s.pausedBy.length ? [] : this.resume();
  }

  resume(): GameEvent[] {
    const s = this.state;
    s.pausedBy = [];
    if (!s.pausedAt) return [];
    const d = this.now() - s.pausedAt;
    if (s.phaseEndsAt) s.phaseEndsAt += d;
    if (s.voteDeadlineAt) s.voteDeadlineAt += d;
    if (s.voteDeadlineStartedAt) s.voteDeadlineStartedAt += d;
    s.pausedAt = null;
    s.pauseReason = null;
    return [this.emit('notice', { scope: 'public' }, 'The game continues.', { kind: 'resumed' })];
  }

  // ---------------------------------------------------------------- phases

  private enterPhase(phase: Phase): GameEvent[] {
    const s = this.state;
    if (phase === 'night' && s.phase === 'day') s.round += 1;
    s.phase = phase;
    s.phaseStartedAt = this.now();
    s.nightChoices = {};
    s.messagesThisPhase = {};
    s.votes = {};
    s.voteDeadlineAt = null;
    s.voteDeadlineStartedAt = null;
    s.speechQueue = [];
    s.floorUntil = null;
    s.nightPlanned = false;
    s.dayClosing = false;
    const timeout = phase === 'night' ? this.settings.nightTimeoutSec : phase === 'day' ? this.settings.dayTimeoutSec : null;
    s.phaseEndsAt = timeout ? s.phaseStartedAt + timeout * 1000 : null;

    let text: string;
    if (phase === 'night') {
      text = `Night ${s.round} falls over Palermo. Players with night roles choose their targets. Murderers may talk privately.`;
    } else if (phase === 'day') {
      text =
        `Day ${s.round} begins. Discuss freely and vote. The day ends when every living player has voted` +
        (s.phaseEndsAt ? ` or when time runs out.` : '.');
    } else {
      text = `Phase: ${phase}.`;
    }
    const out = [this.emit('phase_changed', { scope: 'public' }, text, { phase, round: s.round, endsAt: s.phaseEndsAt })];
    // A night where nobody can act resolves immediately.
    if (phase === 'night' && this.nightComplete()) out.push(...this.resolveNight());
    return out;
  }

  /** Enforce deadlines. Returns events if the phase was resolved. */
  tick(): GameEvent[] {
    const s = this.state;
    if (s.pausedAt) return [];
    const released = this.releaseSpeech();
    if (!s.phaseEndsAt || this.now() < s.phaseEndsAt) return released;
    if (s.phase === 'night') {
      if (this.visual() && !s.nightPlanned) {
        return [...released, this.emit('notice', { scope: 'public' }, 'Time is up for the night.'), ...this.planNight()];
      }
      if (s.nightPlanned) return [...released, ...this.resolveNight()];
      return [...released, this.emit('notice', { scope: 'public' }, 'Time is up for the night.'), ...this.resolveNight()];
    }
    if (s.phase === 'day' && s.dayClosing) {
      // Let the queued messages be heard before the day ends (at most a minute more).
      if (s.speechQueue?.length && this.now() < s.phaseEndsAt + 60_000) return released;
      return [...released, ...this.resolveDay()];
    }
    if (s.phase === 'day') {
      const missing = this.alive()
        .filter((p) => !(p.id in s.votes))
        .map((p) => p.publicName);
      const text = s.voteDeadlineAt
        ? `Voting time is up.${missing.length ? ` No vote from: ${missing.join(', ')}.` : ''}`
        : 'Time is up for the day.';
      return [...released, this.emit('notice', { scope: 'public' }, text), ...this.resolveDay()];
    }
    return released;
  }

  /** Admin: end the current phase now with whatever has been submitted. */
  forceAdvance(): GameEvent[] {
    if (this.state.phase === 'night') return [this.emit('notice', { scope: 'public' }, 'The host ended the night.'), ...this.resolveNight()];
    if (this.state.phase === 'day') return [this.emit('notice', { scope: 'public' }, 'The host ended the day.'), ...this.resolveDay()];
    throw new GameError('Nothing to advance.');
  }

  /** Admin: stop the game without a winner. */
  abort(reason = 'The host stopped the game.'): GameEvent[] {
    if (this.state.phase === 'ended') return [];
    this.state.aborted = true;
    return this.endGame('draw', reason);
  }

  // ---------------------------------------------------------------- chat

  say(playerId: string, message: string, thought?: string): GameEvent[] {
    const p = this.mustPlayer(playerId);
    const text = message.trim().slice(0, 2000);
    if (!text) throw new GameError('Message must not be empty.');
    const s = this.state;
    if (s.phase === 'ended') throw new GameError('The game is over.');
    if (s.phase === 'lobby') {
      return [this.emit('chat', { scope: 'public' }, `${p.publicName}: ${text}`, { message: text }, p.id)];
    }
    if (!p.alive) throw new GameError('You are dead. Dead players cannot talk.');
    if (s.phase === 'night' && !this.knowsPartners(p)) {
      if (p.role && apparentRole(p.role) === 'murderer') {
        throw new GameError('This game the murderers work alone: there is no private chat at night.');
      }
      throw new GameError('It is night. Only the mafia can talk (privately with each other). Wait for the day.');
    }
    this.checkChatLimits(p, text);
    const out = this.emitThought(p, thought, 'chat');
    if (s.phase === 'day') {
      if (this.visual()) {
        // One voice at a time, so people can read along: the rest waits in a queue.
        s.speechQueue ??= [];
        if ((s.floorUntil ?? 0) <= this.now() && !s.speechQueue.length) out.push(...this.speak(p, text));
        else {
          s.speechQueue.push({ playerId: p.id, text });
          out.push(
            this.emit('notice', { scope: 'players', ids: [p.id] }, `Others are speaking: your message is in line (position ${s.speechQueue.length}) and will be heard shortly.`, {
              kind: 'speech_queued',
              position: s.speechQueue.length,
            }, p.id),
          );
        }
        return out;
      }
      out.push(...this.speak(p, text));
      return out;
    }
    // night: murderers' private chat
    out.push(
      this.emit('team_chat', { scope: 'team', team: 'mafia' }, `[mafia] ${p.publicName}: ${text}`, { message: text }, p.id),
    );
    return out;
  }

  /** Enforce the game's chat limits and record the message. Throws a GameError the sender can act on. */
  private checkChatLimits(p: Player, text: string): void {
    const s = this.state;
    const cfg = this.settings;
    if (cfg.maxMessageLength && text.length > cfg.maxMessageLength) {
      throw new GameError(
        `Message too long: ${text.length} characters, the limit is ${cfg.maxMessageLength}. Say it shorter.`,
      );
    }
    const sent = s.messagesThisPhase?.[p.id] ?? 0;
    if (cfg.maxMessagesPerPhase && sent >= cfg.maxMessagesPerPhase) {
      throw new GameError(
        `You already sent ${sent} messages this ${s.phase}, the limit is ${cfg.maxMessagesPerPhase}. You can still vote and act.`,
      );
    }
    const last = s.lastMessageAt?.[p.id];
    if (cfg.chatCooldownSec && last !== undefined) {
      const wait = Math.ceil((last + cfg.chatCooldownSec * 1000 - this.now()) / 1000);
      if (wait > 0) throw new GameError(`Slow down: you can send your next message in ${wait} s.`);
    }
    s.messagesThisPhase = { ...(s.messagesThisPhase ?? {}), [p.id]: sent + 1 };
    s.lastMessageAt = { ...(s.lastMessageAt ?? {}), [p.id]: this.now() };
  }

  /** Remaining chat allowance of a player in the current phase. */
  chatAllowance(playerId: string): PlayerView['chat'] {
    const cfg = this.settings;
    const s = this.state;
    const last = s.lastMessageAt?.[playerId];
    return {
      maxLength: cfg.maxMessageLength,
      left: cfg.maxMessagesPerPhase ? Math.max(0, cfg.maxMessagesPerPhase - (s.messagesThisPhase?.[playerId] ?? 0)) : null,
      cooldownUntil: cfg.chatCooldownSec && last !== undefined ? last + cfg.chatCooldownSec * 1000 : null,
    };
  }

  // ---------------------------------------------------------------- night

  private nightActors(): Player[] {
    return this.alive().filter((p) => this.believedKind(p));
  }

  validNightTargets(p: Player): Player[] {
    const kind = this.believedKind(p);
    if (!kind) return [];
    const s = this.state;
    return this.alive().filter((t) => {
      if (kind === 'kill') {
        if (t.id === p.id) return false;
        if (!this.knowsPartners(p)) return true;
        if (t.role && teamOf(t.role) === 'mafia') return false;
        // Separate kills: never the house a partner already goes to.
        if (this.settings.killMode === 'separate') {
          return !this.partnersOf(p).some((m) => s.nightChoices[m.id]?.target === t.id);
        }
        return true;
      }
      if (kind === 'track') return t.id !== p.id;
      if (kind === 'trap') return s.lastTrapped?.[p.id] !== t.id;
      if (kind === 'protect') {
        if (this.settings.doctorNoRepeat && s.lastProtected[p.id] === t.id) return false;
        if (t.id === p.id) {
          if (this.settings.doctorSelfProtect === 'never') return false;
          if (this.settings.doctorSelfProtect === 'once' && s.selfProtectUsed.includes(p.id)) return false;
        }
        return true;
      }
      return false;
    });
  }

  nightAction(playerId: string, targetRef: string, thought?: string): GameEvent[] {
    const s = this.state;
    const p = this.mustPlayer(playerId);
    if (s.phase !== 'night') throw new GameError('Night actions can only be used at night.');
    if (!p.alive) throw new GameError('You are dead.');
    if (s.nightPlanned) throw new GameError('The night is already under way: actions are locked until dawn.');
    const kind = this.believedKind(p);
    if (!kind) throw new GameError('Your role has no night action. Just wait for the day.');
    let targetId: string;
    let label: string;
    if (targetRef.trim().toLowerCase() === PASS) {
      if (kind !== 'kill') throw new GameError('Only murderers can pass. Choose one of the valid targets.');
      targetId = PASS;
      label = 'nobody';
    } else {
      const target = this.resolveTarget(targetRef);
      const valid = this.validNightTargets(p);
      if (!valid.some((t) => t.id === target.id)) {
        const partnerThere = kind === 'kill' && this.partnersOf(p).some((m) => s.nightChoices[m.id]?.target === target.id);
        throw new GameError(
          (partnerThere
            ? `Your partner already goes to ${target.publicName}'s house tonight: pick someone else or pass. `
            : `You cannot target ${target.publicName} tonight. `) +
            `Valid targets: ${valid.map((t) => t.publicName).join(', ')}${kind === 'kill' ? ', pass' : ''}.`,
        );
      }
      targetId = target.id;
      label = target.publicName;
    }
    const changed = !!s.nightChoices[p.id];
    s.nightChoices[p.id] = { kind, target: targetId, at: this.now() };
    const verb = { kill: 'to kill', protect: 'to protect', track: 'to track', trap: 'to set a trap at the house of' }[kind];
    const out = this.emitThought(p, thought, 'night action');
    out.push(
      this.emit(
        'night_action',
        this.knowsPartners(p) ? { scope: 'team', team: 'mafia' } : { scope: 'players', ids: [p.id] },
        targetId === PASS
          ? `${p.publicName} ${changed ? 'changed their mind and' : ''} will stay home tonight (pass).`.replace('  ', ' ')
          : `${p.publicName} ${changed ? 'changed their choice and now chose' : 'chose'} ${verb} ${label}.`,
        { kind, target: targetId },
        p.id,
      ),
    );
    if (this.nightComplete()) out.push(...(this.visual() ? this.planNight() : this.resolveNight()));
    return out;
  }

  nightComplete(): boolean {
    return this.nightActors().every(
      (p) => this.state.nightChoices[p.id] || (this.believedKind(p) !== 'kill' && this.validNightTargets(p).length === 0),
    );
  }

  /** 'shared' kill mode: the target the murderers agreed on (plurality, ties to the most recent choice). */
  private murderTarget(): { target: string; killer: string } | null {
    const choices = Object.entries(this.state.nightChoices)
      .filter(([id, c]) => c.kind === 'kill' && c.target !== PASS && this.player(id)?.role === 'murderer')
      .sort((a, b) => a[1].at - b[1].at);
    if (!choices.length) return null;
    const counts = new Map<string, number>();
    for (const [, c] of choices) counts.set(c.target, (counts.get(c.target) ?? 0) + 1);
    const max = Math.max(...counts.values());
    const top = [...counts.entries()].filter(([, n]) => n === max).map(([t]) => t);
    for (let i = choices.length - 1; i >= 0; i--) {
      const [killer, c] = choices[i];
      if (top.includes(c.target)) return { target: c.target, killer };
    }
    return null;
  }

  /**
   * Night resolution. Every action is a visit to a house: traps first (every visitor of a trapped house fails), then
   * protections, kills and finally information (tracker, trapper). Crazy roles never leave home: their actions do
   * nothing and their reports are always wrong.
   */
  /** Who goes where tonight and who walks into a trap (pure: no state changes). */
  computeVisits(): NightVisit[] {
    const s = this.state;
    const shared = this.settings.killMode === 'shared' ? this.murderTarget() : null;
    const visits: NightVisit[] = [];
    for (const [pid, c] of Object.entries(s.nightChoices)) {
      if (c.target === PASS) continue;
      const p = this.player(pid)!;
      // Shared kills: only the murderer who performs the kill leaves the house.
      if (c.kind === 'kill' && shared && p.role === 'murderer' && shared.killer !== pid) continue;
      const crazy = isCrazy(p.role);
      visits.push({ from: pid, to: c.target, kind: c.kind, home: crazy || c.target === pid, crazy, caught: false });
    }
    // Traps: every visitor of a trapped house walks into it (owners inside their own house do not).
    const trapped = new Set(visits.filter((v) => v.kind === 'trap' && !v.crazy).map((v) => v.to));
    for (const v of visits) if (!v.crazy && !v.home && v.kind !== 'trap' && trapped.has(v.to)) v.caught = true;
    return visits;
  }

  /**
   * Night resolution. Every action is a visit to a house: traps first (every visitor of a trapped house fails), then
   * protections, kills and finally information (tracker, trapper). Crazy roles never leave home: their actions do
   * nothing and their reports are always wrong.
   */
  private resolveNight(): GameEvent[] {
    const s = this.state;
    s.lastTrapped ??= {};
    const out: GameEvent[] = [];
    const name = (id: string) => this.player(id)!.publicName;
    const aliveAtNight = this.alive();
    const visits = this.computeVisits();
    // Bookkeeping is the same for crazy roles, so their options look exactly like the real role's.
    for (const [pid, c] of Object.entries(s.nightChoices)) {
      if (c.target === PASS) continue;
      if (c.kind === 'protect') {
        s.lastProtected[pid] = c.target;
        if (c.target === pid && !s.selfProtectUsed.includes(pid)) s.selfProtectUsed.push(pid);
      }
      if (c.kind === 'trap') s.lastTrapped[pid] = c.target;
    }
    for (const p of s.players) {
      if (s.nightChoices[p.id]) continue;
      const kind = this.believedKind(p);
      if (kind === 'protect') delete s.lastProtected[p.id];
      if (kind === 'trap') delete s.lastTrapped[p.id];
    }

    for (const v of visits.filter((x) => x.caught)) {
      const failed = { kill: 'You killed nobody.', protect: 'You protected nobody.', track: 'You learned nothing.', trap: '' }[v.kind];
      out.push(
        this.emit('trap_result', { scope: 'players', ids: [v.from] }, `You walked into a trap in front of ${name(v.to)}'s house last night. ${failed}`, {
          house: v.to,
          caught: true,
        }, v.from),
      );
    }
    for (const v of visits.filter((x) => x.kind === 'trap')) {
      const where = v.to === v.from ? 'your house' : `${name(v.to)}'s house`;
      let roles = visits.filter((x) => x.caught && x.to === v.to).map((x) => ROLES[this.player(x.from)!.role!].name);
      if (v.crazy) {
        // Always wrong: a catch when nobody came, nothing when somebody did.
        const cameAnyway = visits.some((x) => !x.crazy && !x.home && x.kind !== 'trap' && x.to === v.to);
        const inPlay = [...new Set(s.players.map((x) => apparentRole(x.role!)))].filter((r) => r === 'murderer' || r === 'doctor' || r === 'tracker');
        roles = cameAnyway ? [] : [ROLES[pick<RoleId>(s, inPlay.length ? inPlay : ['murderer'])].name];
      }
      out.push(
        this.emit(
          'trap_result',
          { scope: 'players', ids: [v.from] },
          roles.length
            ? `Your trap in front of ${where} caught someone last night: ${roles.map((r) => `a ${r}`).join(' and ')}.`
            : `Nobody walked into your trap in front of ${where} last night.`,
          { house: v.to, caughtRoles: roles },
          v.from,
        ),
      );
    }

    // 2. Protections and 3. kills.
    const protectors = new Map<string, string[]>();
    for (const v of visits) if (v.kind === 'protect' && !v.crazy && !v.caught) protectors.set(v.to, [...(protectors.get(v.to) ?? []), v.from]);
    const victims: Player[] = [];
    const saved: string[] = [];
    const attacked = [...new Set(visits.filter((v) => v.kind === 'kill' && !v.crazy && !v.caught).map((v) => v.to))];
    for (const id of attacked) {
      const t = this.player(id)!;
      if (!t.alive) continue;
      const docs = protectors.get(id);
      if (docs) {
        saved.push(id);
        if (this.settings.doctorLearnsSave) {
          out.push(
            this.emit('doctor_result', { scope: 'players', ids: docs }, `Your patient ${t.publicName} was attacked last night, and you saved them!`, { saved: id }),
          );
        }
        continue;
      }
      t.alive = false;
      t.death = { round: s.round, phase: 'night', cause: 'killed' };
      victims.push(t);
    }

    // 4. Tracker results (crazy trackers always get a wrong answer).
    const wentTo = (pid: string) => visits.find((v) => v.from === pid && !v.home)?.to ?? null;
    for (const v of visits.filter((x) => x.kind === 'track' && !x.caught)) {
      const tracked = this.player(v.to)!;
      let dest = wentTo(tracked.id);
      if (v.crazy) {
        const wrong = [null, ...aliveAtNight.map((x) => x.id).filter((id) => id !== tracked.id)].filter((x) => x !== dest);
        dest = pick(s, wrong);
      }
      const place = dest === v.from ? 'your house' : dest ? `${name(dest)}'s house` : null;
      out.push(
        this.emit(
          'tracker_result',
          { scope: 'players', ids: [v.from] },
          place ? `You followed ${tracked.publicName} last night: they visited ${place}.` : `You followed ${tracked.publicName} last night: they stayed home.`,
          { tracked: tracked.id, visited: dest },
          v.from,
        ),
      );
    }

    const revealRole = (p: Player) => (this.settings.revealRoleOnDeath ? ` ${p.publicName} was a ${ROLES[p.role!].name}.` : '');
    const names = victims.map((v) => v.publicName);
    out.push(
      this.emit(
        'night_resolved',
        { scope: 'public' },
        victims.length
          ? `Dawn breaks. ${names.join(' and ')} ${victims.length > 1 ? 'were' : 'was'} found dead.${victims.map(revealRole).join('')}`
          : 'Dawn breaks. Nobody died last night.',
        {
          victim: victims[0]?.id ?? null,
          victims: victims.map((v) => v.id),
          victimRole: victims[0] && this.settings.revealRoleOnDeath ? victims[0].role : undefined,
        },
      ),
    );
    // Hidden details (who went where) for the god view and the night animation.
    out.push(
      this.emit('notice', { scope: 'admin' }, 'Night summary (admin).', {
        kind: 'night_summary',
        victim: victims[0]?.id ?? null,
        victims: victims.map((v) => v.id),
        attempted: attacked[0] ?? null,
        killer: visits.find((v) => v.kind === 'kill' && !v.crazy && v.to === victims[0]?.id)?.from ?? null,
        saved: saved[0] ?? null,
        savedAll: saved,
        visits,
        choices: { ...s.nightChoices },
      }),
    );

    const win = this.checkWin();
    if (win) out.push(...this.endGame(win.winner, win.reason));
    else out.push(...this.enterPhase('day'));
    return out;
  }

  // ---------------------------------------------------------------- ventriloquist

  /** Once per day: a chat message appears in another living player's name. */
  throwVoice(playerId: string, asRef: string, message: string, thought?: string): GameEvent[] {
    const s = this.state;
    const p = this.mustPlayer(playerId);
    if (s.phase !== 'day') throw new GameError('You can only throw your voice during the day.');
    if (!p.alive) throw new GameError('You are dead.');
    if (!p.role || ROLES[p.role].dayAction !== 'throw_voice') throw new GameError('You cannot throw your voice.');
    s.voiceUsed ??= {};
    if (s.voiceUsed[p.id] === s.round) throw new GameError('You already threw your voice today. Try again tomorrow.');
    const t = this.resolveTarget(asRef);
    if (!t.alive) throw new GameError(`${t.publicName} is dead: the dead do not talk.`);
    if (t.id === p.id) throw new GameError('Speak as someone else (use say for your own messages).');
    const text = message.trim().slice(0, 2000);
    if (!text) throw new GameError('Message must not be empty.');
    // Counts against the ventriloquist's own chat limits (length, per-day count, cooldown).
    this.checkChatLimits(p, text);
    s.voiceUsed[p.id] = s.round;
    const out = this.emitThought(p, thought, `throw voice as ${t.publicName}`);
    if (this.knowsPartners(p)) {
      out.push(this.emit('team_chat', { scope: 'team', team: 'mafia' }, `[mafia] ${p.publicName} throws their voice as ${t.publicName}: "${text}"`, { message: `(as ${t.publicName}) ${text}`, forged: true }, p.id));
    }
    if (this.visual()) {
      s.speechQueue ??= [];
      if ((s.floorUntil ?? 0) <= this.now() && !s.speechQueue.length) out.push(...this.speak(t, text, p.id));
      else {
        s.speechQueue.push({ playerId: t.id, text, forgedBy: p.id });
        out.push(this.emit('notice', { scope: 'players', ids: [p.id] }, `Others are speaking: your forged message is in line (position ${s.speechQueue.length}).`, { kind: 'speech_queued', position: s.speechQueue.length }, p.id));
      }
    } else {
      out.push(...this.speak(t, text, p.id));
    }
    return out;
  }

  // ---------------------------------------------------------------- gunman

  shoot(playerId: string, targetRef: string, thought?: string): GameEvent[] {
    const s = this.state;
    const p = this.mustPlayer(playerId);
    if (s.phase !== 'day') throw new GameError('You can only shoot during the day.');
    if (!p.alive) throw new GameError('You are dead.');
    if (!p.role || ROLES[p.role].dayAction !== 'shoot') throw new GameError('You have no gun.');
    s.shotsFired ??= {};
    if ((s.shotsFired[p.id] ?? 0) >= 1) throw new GameError('You already used your only bullet.');
    const t = this.resolveTarget(targetRef);
    if (!t.alive) throw new GameError(`${t.publicName} is already dead.`);
    if (t.id === p.id) throw new GameError('You cannot shoot yourself.');
    s.shotsFired[p.id] = 1;
    s.revealed = [...new Set([...(s.revealed ?? []), p.id])];
    t.alive = false;
    t.death = { round: s.round, phase: 'day', cause: 'shot' };
    delete s.votes[t.id];
    for (const [voter, target] of Object.entries(s.votes)) if (target === t.id) delete s.votes[voter];
    const reveal = this.settings.revealRoleOnDeath ? ` ${t.publicName} was a ${ROLES[t.role!].name}.` : '';
    const out = this.emitThought(p, thought, 'shot');
    out.push(
      this.emit('shot', { scope: 'public' }, `Bang! ${p.publicName} is the Gunman and shot ${t.publicName}.${reveal}`, {
        target: t.id,
        role: this.settings.revealRoleOnDeath ? t.role : undefined,
      }, p.id),
    );
    const win = this.checkWin();
    if (win) return [...out, ...this.endGame(win.winner, win.reason)];
    if (Object.keys(s.votes).length >= this.alive().length) out.push(...this.everyoneVoted());
    return out;
  }

  // ---------------------------------------------------------------- day

  vote(playerId: string, targetRef: string | null, thought?: string): GameEvent[] {
    const s = this.state;
    const p = this.mustPlayer(playerId);
    if (s.phase !== 'day') throw new GameError('Voting is only possible during the day.');
    if (!p.alive) throw new GameError('You are dead and cannot vote.');
    const out = this.emitThought(p, thought, 'vote');
    const visibility: Visibility = this.settings.publicVotes ? { scope: 'public' } : { scope: 'players', ids: [p.id] };

    if (targetRef === null || targetRef === '') {
      if (!s.votes[p.id]) return out;
      delete s.votes[p.id];
      out.push(this.emit('vote', visibility, `${p.publicName} withdrew their vote.`, { target: null }, p.id));
      return out;
    }

    let targetId: string;
    let label: string;
    if (targetRef.trim().toLowerCase() === SKIP) {
      if (!this.settings.allowSkipVote) throw new GameError('Skip votes are disabled in this game.');
      targetId = SKIP;
      label = 'skip (no elimination)';
    } else {
      const t = this.resolveTarget(targetRef);
      if (!t.alive) throw new GameError(`${t.publicName} is already dead.`);
      if (t.id === p.id) throw new GameError('You cannot vote for yourself.');
      targetId = t.id;
      label = t.publicName;
    }
    const prev = s.votes[p.id];
    s.votes[p.id] = targetId;
    const voted = Object.keys(s.votes).length;
    const alive = this.alive().length;
    out.push(
      this.emit(
        'vote',
        visibility,
        `${p.publicName} ${prev ? 'changed their vote to' : 'votes for'} ${label}. (${voted}/${alive} have voted)`,
        { target: targetId },
        p.id,
      ),
    );
    if (!this.settings.publicVotes) {
      out.push(this.emit('notice', { scope: 'public' }, `${voted}/${alive} players have voted.`, { voted, alive }));
    }
    if (voted >= alive) out.push(...this.everyoneVoted());
    else out.push(...this.maybeStartVoteDeadline(voted, alive));
    return out;
  }

  /** Everyone alive has voted: the day ends now, or in visual games once it lasted long enough to follow. */
  private everyoneVoted(): GameEvent[] {
    const s = this.state;
    if (!this.visual()) return this.resolveDay();
    if (s.dayClosing) return [];
    const minEnd = (s.phaseStartedAt ?? this.now()) + VISUAL_MIN_DAY_SEC * 1000;
    const end = Math.max(this.now() + 5_000, minEnd);
    s.dayClosing = true;
    s.phaseEndsAt = s.phaseEndsAt ? Math.min(s.phaseEndsAt, end) : end;
    const sec = Math.round((s.phaseEndsAt - this.now()) / 1000);
    return [this.emit('notice', { scope: 'public' }, `Everyone has voted. The day ends in ${sec} s; votes can still change.`, { kind: 'day_closing', until: s.phaseEndsAt })];
  }

  /** Stall guard: two thirds have voted, the rest have until the chat has been quiet for settings.voteDeadlineSec. */
  private maybeStartVoteDeadline(voted: number, alive: number): GameEvent[] {
    const s = this.state;
    const sec = this.settings.voteDeadlineSec;
    if (!sec || s.voteDeadlineStartedAt || voted * 3 < alive * 2) return [];
    s.voteDeadlineStartedAt = this.now();
    this.extendVoteDeadline();
    const missing = this.alive()
      .filter((p) => !(p.id in s.votes))
      .map((p) => p.publicName);
    return [
      this.emit(
        'notice',
        { scope: 'public' },
        `${voted}/${alive} have voted. ${missing.join(', ')}: vote soon. The day ends ${sec} s after the last chat message ` +
          `(at most ${Math.max(sec, VOTE_DEADLINE_CAP_SEC) / 60} min from now) with the votes cast so far.`,
        { deadline: s.voteDeadlineAt, missing },
      ),
    ];
  }

  /** Moves the vote deadline to `voteDeadlineSec` after now, within the cap and the day's own time limit. */
  private extendVoteDeadline(): void {
    const s = this.state;
    const sec = this.settings.voteDeadlineSec;
    if (!sec || !s.voteDeadlineStartedAt || s.phase !== 'day' || s.dayClosing) return;
    const cap = s.voteDeadlineStartedAt + Math.max(sec, VOTE_DEADLINE_CAP_SEC) * 1000;
    const dayEnd = this.settings.dayTimeoutSec && s.phaseStartedAt ? s.phaseStartedAt + this.settings.dayTimeoutSec * 1000 : Infinity;
    s.voteDeadlineAt = Math.min(this.now() + sec * 1000, cap, dayEnd);
    s.phaseEndsAt = s.voteDeadlineAt;
  }

  tally(): { counts: Record<string, number>; eliminated: string | null; tie: boolean } {
    const counts: Record<string, number> = {};
    for (const t of Object.values(this.state.votes)) counts[t] = (counts[t] ?? 0) + 1;
    const entries = Object.entries(counts);
    if (!entries.length) return { counts, eliminated: null, tie: false };
    const max = Math.max(...entries.map(([, n]) => n));
    const top = entries.filter(([, n]) => n === max).map(([t]) => t);
    if (top.length > 1) return { counts, eliminated: null, tie: true };
    return { counts, eliminated: top[0] === SKIP ? null : top[0], tie: false };
  }

  private resolveDay(): GameEvent[] {
    const s = this.state;
    const out: GameEvent[] = [];
    const { counts, eliminated, tie } = this.tally();
    const breakdown = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t === SKIP ? 'skip' : this.player(t)!.publicName}: ${n}`)
      .join(', ');
    const votesByName = Object.fromEntries(
      Object.entries(s.votes).map(([v, t]) => [this.player(v)!.publicName, t === SKIP ? SKIP : this.player(t)!.publicName]),
    );

    let text: string;
    if (eliminated) {
      const p = this.player(eliminated)!;
      p.alive = false;
      p.death = { round: s.round, phase: 'day', cause: 'eliminated' };
      const reveal = this.settings.revealRoleOnDeath ? ` They were a ${ROLES[p.role!].name}.` : '';
      text = `The town has voted. ${p.publicName} is eliminated.${reveal} Votes: ${breakdown || 'none'}.`;
    } else if (tie) {
      text = `The vote is tied (${breakdown}). Nobody is eliminated today.`;
    } else {
      text = `The town decided not to eliminate anyone today.${breakdown ? ` Votes: ${breakdown}.` : ''}`;
    }
    out.push(
      this.emit('day_resolved', { scope: 'public' }, text, {
        eliminated,
        eliminatedRole: eliminated && this.settings.revealRoleOnDeath ? this.player(eliminated)!.role : undefined,
        counts,
        votes: this.settings.publicVotes ? votesByName : undefined,
        tie,
      }),
    );
    out.push(this.emit('notice', { scope: 'admin' }, 'Day votes (admin).', { kind: 'day_votes', votes: { ...s.votes }, eliminated }));
    const win = this.checkWin();
    if (win) out.push(...this.endGame(win.winner, win.reason));
    else out.push(...this.enterPhase('night'));
    return out;
  }

  // ---------------------------------------------------------------- end

  checkWin(): { winner: Winner; reason: string } | null {
    const alive = this.alive();
    const mafia = alive.filter((p) => p.role && teamOf(p.role) === 'mafia').length;
    const town = alive.length - mafia;
    if (mafia === 0) return { winner: 'town', reason: 'The whole mafia has been eliminated. The town wins!' };
    if (mafia >= town) return { winner: 'mafia', reason: 'The murderers now control Palermo. The murderers win!' };
    if (this.settings.maxRounds && this.state.round >= this.settings.maxRounds && this.state.phase === 'day') {
      return { winner: 'draw', reason: `Round limit (${this.settings.maxRounds}) reached. The game ends in a draw.` };
    }
    return null;
  }

  private endGame(winner: Winner, reason: string): GameEvent[] {
    const s = this.state;
    s.phase = 'ended';
    s.winner = winner;
    s.endedAt = this.now();
    s.phaseEndsAt = null;
    const roster = s.players.map((p) => `${p.publicName} (${ROLES[p.role!]?.name ?? '?'}${p.alive ? '' : ', dead'})`).join(', ');
    const truth = s.players
      .filter((p) => isCrazy(p.role))
      .map((p) =>
        this.emit('notice', { scope: 'players', ids: [p.id] }, `The truth: you were a ${ROLES[p.role!].name}. Your actions had no effect and your results were not real.`, {
          kind: 'crazy_reveal',
          role: p.role,
        }, p.id),
      );
    return [
      ...truth,
      this.emit('game_ended', { scope: 'public' }, `${reason} Roles: ${roster}.`, {
        winner,
        reason,
        roles: Object.fromEntries(s.players.map((p) => [p.publicName, p.role])),
      }),
    ];
  }

  // ---------------------------------------------------------------- views

  required(playerId: string): RequiredAction {
    const s = this.state;
    const p = this.player(playerId);
    if (!p) return { kind: 'none', done: true, hint: 'You are not in this game.' };
    if (s.phase === 'lobby') {
      return p.ready
        ? { kind: 'none', done: true, hint: 'You are ready. Wait for the game to start.' }
        : { kind: 'ready', done: false, hint: 'Mark yourself ready.' };
    }
    if (s.phase === 'ended') return { kind: 'none', done: true, hint: 'The game is over. Write your reflection.' };
    if (!p.alive) return { kind: 'none', done: true, hint: 'You are dead. You can only watch.' };
    if (s.phase === 'night') {
      const kind = this.believedKind(p);
      if (!kind) return { kind: 'none', done: true, hint: 'You have no night action. Wait for the day.' };
      if (s.nightPlanned) return { kind: 'none', done: true, hint: 'The night is under way: actions are locked. Wait for dawn.' };
      const options = this.validNightTargets(p).map((t) => t.publicName);
      if (kind === 'kill') options.push(PASS);
      const choice = s.nightChoices[p.id];
      const verb = { kill: 'kill', protect: 'protect', track: 'track', trap: 'trap the house of' }[kind];
      const partners =
        kind === 'kill'
          ? this.partnersOf(p)
              .filter((m) => m.alive && s.nightChoices[m.id])
              .map((m) => {
                const t = s.nightChoices[m.id].target;
                return `${m.publicName} ${t === PASS ? 'passes' : `goes to ${this.player(t)!.publicName}`}`;
              })
          : [];
      return {
        kind: 'night_action',
        actionKind: kind,
        options,
        done: !!choice,
        hint:
          (choice
            ? choice.target === PASS
              ? 'You chose to stay home tonight. You may change it until the night ends.'
              : `You chose to ${verb} ${this.player(choice.target)!.publicName}. You may change it until the night ends.`
            : kind === 'kill'
              ? 'Choose a victim with night_action, or target "pass" to stay home tonight.'
              : `Choose a player to ${verb} with night_action.`) + (partners.length ? ` Your partners: ${partners.join('; ')}.` : ''),
      };
    }
    const options = this.alive()
      .filter((t) => t.id !== p.id)
      .map((t) => t.publicName);
    const shootOptions = [...options];
    if (this.settings.allowSkipVote) options.push(SKIP);
    const v = s.votes[p.id];
    const canShoot = !!p.role && ROLES[p.role].dayAction === 'shoot' && !(s.shotsFired?.[p.id] ?? 0);
    const canThrow = !!p.role && ROLES[p.role].dayAction === 'throw_voice' && s.voiceUsed?.[p.id] !== s.round;
    const dayAction = canShoot
      ? { dayAction: { kind: 'shoot' as const, options: shootOptions } }
      : canThrow
        ? { dayAction: { kind: 'throw_voice' as const, options: shootOptions } }
        : {};
    return {
      kind: 'vote',
      options,
      done: !!v,
      ...dayAction,
      hint:
        (v
          ? `You voted for ${v === SKIP ? SKIP : this.player(v)!.publicName}. You may change your vote until everyone has voted.`
          : 'Discuss, then vote. The day ends when every living player has voted.') +
        (canShoot ? ' You still have your one bullet: shoot kills a player at once and reveals you as the Gunman.' : '') +
        (canThrow ? ' Once today you can throw your voice: throw_voice makes a message appear in another player\'s name.' : ''),
    };
  }

  /** View of the game for a player, or for the admin when viewerId is null. */
  view(viewerId: string | null): PlayerView {
    const s = this.state;
    const isAdmin = viewerId === null;
    const me = viewerId ? this.player(viewerId) ?? null : null;
    const anonymous = this.settings.identityVisibility === 'anonymous';
    const ended = s.phase === 'ended';
    // Crazy roles see the role they believe in until the game is over.
    const myRole: RoleId | null = me?.role ? (ended ? me.role : apparentRole(me.role)) : null;
    const knowsMates = !!me && this.knowsPartners(me);

    const players: PublicPlayer[] = s.players.map((p) => {
      const pub: PublicPlayer = { id: p.id, name: p.publicName, alive: p.alive, ready: p.ready, death: p.death };
      const showIdentity = isAdmin || ended || !anonymous || p.id === viewerId;
      if (showIdentity) {
        pub.kind = p.kind;
        pub.provider = p.provider;
        pub.model = p.model;
        pub.verified = p.verified;
        if (anonymous) pub.realName = p.name;
      }
      const revealed =
        isAdmin ||
        ended ||
        (!p.alive && this.settings.revealRoleOnDeath) ||
        !!s.revealed?.includes(p.id) ||
        (knowsMates && !!p.role && teamOf(p.role) === 'mafia');
      const shown = revealed ? p.role : p.id === viewerId ? myRole : null;
      if (shown) {
        pub.role = shown;
        pub.team = teamOf(shown);
      }
      return pub;
    });

    const votesVisible = isAdmin || this.settings.publicVotes;
    const votes: Record<string, string> = {};
    for (const [v, t] of Object.entries(s.votes)) {
      if (votesVisible || v === viewerId) votes[this.player(v)!.publicName] = t === SKIP ? SKIP : this.player(t)!.publicName;
    }

    return {
      gameId: s.id,
      phase: s.phase,
      round: s.round,
      phaseEndsAt: s.phaseEndsAt,
      settings: s.settings,
      winner: s.winner,
      isAdmin,
      paused: s.pausedAt ? { since: s.pausedAt, reason: s.pauseReason ?? '' } : null,
      you: me
        ? {
            id: me.id,
            name: me.publicName,
            role: myRole,
            team: myRole ? teamOf(myRole) : null,
            alive: me.alive,
            roleDescription: myRole ? ROLES[myRole].description : null,
            teammates: this.partnersOf(me).map((p) => p.publicName),
          }
        : null,
      players,
      votes,
      votedCount: Object.keys(s.votes).length,
      aliveCount: this.alive().length,
      required: me ? this.required(me.id) : { kind: 'none', done: true, hint: 'Spectating.' },
      chat: me ? this.chatAllowance(me.id) : { maxLength: this.settings.maxMessageLength, left: null, cooldownUntil: null },
      lastEventSeq: s.events.length,
    };
  }
}

function countRoles(roles: string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of roles) c[r] = (c[r] ?? 0) + 1;
  return c;
}

function summarizeRoles(roles: string[]): string {
  return Object.entries(countRoles(roles))
    .map(([r, n]) => `${n}x ${ROLES[r as keyof typeof ROLES].name}`)
    .join(', ');
}
