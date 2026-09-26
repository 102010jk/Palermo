import { DEFAULT_SETTINGS, ROLES, rolesFor, teamOf } from './roles.ts';
import { shuffle } from './rng.ts';
import type {
  EventType,
  GameEvent,
  GameSettings,
  GameState,
  Phase,
  Player,
  PlayerInput,
  PlayerView,
  PublicPlayer,
  RequiredAction,
  Team,
  Visibility,
  Winner,
} from './types.ts';

export class GameError extends Error {}

/** Names used as aliases in anonymous games. */
export const TOWN_NAMES = [
  'Salvatore', 'Lucia', 'Giuseppe', 'Rosalia', 'Vito', 'Carmela', 'Tommaso', 'Giulia', 'Enzo', 'Francesca',
  'Nino', 'Serafina', 'Rocco', 'Concetta', 'Aldo', 'Pina', 'Marco', 'Teresa', 'Paolo', 'Agata',
];

export const SKIP = 'skip';

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
    if (name.toLowerCase() === SKIP) throw new GameError(`"${SKIP}" is reserved.`);
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
            ? `Roles in play: ${summarizeRoles(roles)}.`
            : 'The role setup is secret: nobody knows how many of each role are in play.'),
        { players: s.players.map((p) => p.publicName), roles: this.settings.announceRoles ? countRoles(roles) : undefined },
      ),
    );

    const murderers = s.players.filter((p) => p.role === 'murderer');
    for (const p of s.players) {
      const role = ROLES[p.role!];
      let text = `Your role: ${role.name}. ${role.description}`;
      const mates = p.role === 'murderer' ? murderers.filter((m) => m.id !== p.id).map((m) => m.publicName) : [];
      if (mates.length) text += ` Your fellow murderers: ${mates.join(', ')}.`;
      out.push(
        this.emit('role_assigned', { scope: 'players', ids: [p.id] }, text, { role: p.role, teammates: mates }, p.id),
      );
    }
    out.push(...this.enterPhase(this.settings.startPhase));
    return out;
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
    if (!s.phaseEndsAt || this.now() < s.phaseEndsAt) return [];
    if (s.phase === 'night') return [this.emit('notice', { scope: 'public' }, 'Time is up for the night.'), ...this.resolveNight()];
    if (s.phase === 'day') return [this.emit('notice', { scope: 'public' }, 'Time is up for the day.'), ...this.resolveDay()];
    return [];
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
    if (s.phase === 'night' && p.role !== 'murderer') {
      throw new GameError('It is night. Only murderers can talk (privately with each other). Wait for the day.');
    }
    this.checkChatLimits(p, text);
    const out = this.emitThought(p, thought, 'chat');
    if (s.phase === 'day') {
      out.push(this.emit('chat', { scope: 'public' }, `${p.publicName}: ${text}`, { message: text }, p.id));
      return out;
    }
    // night: murderers' private chat
    out.push(
      this.emit('team_chat', { scope: 'team', team: 'mafia' }, `[murderers] ${p.publicName}: ${text}`, { message: text }, p.id),
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
    return this.alive().filter((p) => p.role && ROLES[p.role].nightAction);
  }

  validNightTargets(p: Player): Player[] {
    const kind = p.role ? ROLES[p.role].nightAction : null;
    if (!kind) return [];
    return this.alive().filter((t) => {
      if (kind === 'kill') return t.role !== 'murderer';
      if (kind === 'track') return t.id !== p.id;
      if (kind === 'protect') {
        if (this.settings.doctorNoRepeat && this.state.lastProtected[p.id] === t.id) return false;
        if (t.id === p.id) {
          if (this.settings.doctorSelfProtect === 'never') return false;
          if (this.settings.doctorSelfProtect === 'once' && this.state.selfProtectUsed.includes(p.id)) return false;
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
    const kind = p.role ? ROLES[p.role].nightAction : null;
    if (!kind) throw new GameError('Your role has no night action. Just wait for the day.');
    const target = this.resolveTarget(targetRef);
    if (!this.validNightTargets(p).some((t) => t.id === target.id)) {
      throw new GameError(
        `You cannot target ${target.publicName} tonight. Valid targets: ${this.validNightTargets(p)
          .map((t) => t.publicName)
          .join(', ')}.`,
      );
    }
    const changed = !!s.nightChoices[p.id];
    s.nightChoices[p.id] = { kind, target: target.id, at: this.now() };
    const verb = kind === 'kill' ? 'to kill' : kind === 'protect' ? 'to protect' : 'to track';
    const out = this.emitThought(p, thought, 'night action');
    out.push(
      this.emit(
        'night_action',
        p.role === 'murderer' ? { scope: 'team', team: 'mafia' } : { scope: 'players', ids: [p.id] },
        `${p.publicName} ${changed ? 'changed their choice and now chose' : 'chose'} ${verb} ${target.publicName}.`,
        { kind, target: target.id },
        p.id,
      ),
    );
    if (this.nightComplete()) out.push(...this.resolveNight());
    return out;
  }

  nightComplete(): boolean {
    return this.nightActors().every((p) => this.state.nightChoices[p.id] || this.validNightTargets(p).length === 0);
  }

  /** The target the murderers agreed on: plurality of their choices, ties broken by the most recent choice. */
  private murderTarget(): { target: string; killer: string } | null {
    const choices = Object.entries(this.state.nightChoices)
      .filter(([, c]) => c.kind === 'kill')
      .sort((a, b) => a[1].at - b[1].at);
    if (!choices.length) return null;
    const counts = new Map<string, number>();
    for (const [, c] of choices) counts.set(c.target, (counts.get(c.target) ?? 0) + 1);
    const max = Math.max(...counts.values());
    const top = [...counts.entries()].filter(([, n]) => n === max).map(([t]) => t);
    // Most recent choice among top targets wins, and that murderer performs the kill.
    for (let i = choices.length - 1; i >= 0; i--) {
      const [killer, c] = choices[i];
      if (top.includes(c.target)) return { target: c.target, killer };
    }
    return null;
  }

  private resolveNight(): GameEvent[] {
    const s = this.state;
    const out: GameEvent[] = [];
    const murder = this.murderTarget();

    // Who left their house tonight, and where they went.
    const visits = new Map<string, string>();
    if (murder) visits.set(murder.killer, murder.target);
    const protectedIds = new Set<string>();
    for (const [pid, c] of Object.entries(s.nightChoices)) {
      if (c.kind === 'protect') {
        protectedIds.add(c.target);
        visits.set(pid, c.target);
        s.lastProtected[pid] = c.target;
        if (c.target === pid && !s.selfProtectUsed.includes(pid)) s.selfProtectUsed.push(pid);
      } else if (c.kind === 'track') {
        visits.set(pid, c.target);
      }
    }
    // Doctors who did not act lose their "last protected" restriction.
    for (const doc of s.players.filter((p) => p.role === 'doctor' && !s.nightChoices[p.id])) delete s.lastProtected[doc.id];

    // Tracker results.
    for (const [pid, c] of Object.entries(s.nightChoices)) {
      if (c.kind !== 'track') continue;
      const tracked = this.player(c.target)!;
      const dest = visits.get(tracked.id);
      const text = dest
        ? `You followed ${tracked.publicName} last night: they visited ${this.player(dest)!.publicName}'s house.`
        : `You followed ${tracked.publicName} last night: they stayed home.`;
      out.push(this.emit('tracker_result', { scope: 'players', ids: [pid] }, text, { tracked: tracked.id, visited: dest ?? null }, pid));
    }

    let victim: Player | null = null;
    if (murder) {
      const target = this.player(murder.target)!;
      if (protectedIds.has(target.id)) {
        if (this.settings.doctorLearnsSave) {
          const doctors = Object.entries(s.nightChoices)
            .filter(([, c]) => c.kind === 'protect' && c.target === target.id)
            .map(([id]) => id);
          out.push(
            this.emit('doctor_result', { scope: 'players', ids: doctors }, `Your patient ${target.publicName} was attacked last night, and you saved them!`, { saved: target.id }),
          );
        }
      } else {
        victim = target;
        target.alive = false;
        target.death = { round: s.round, phase: 'night', cause: 'killed' };
      }
    }

    const reveal = victim && this.settings.revealRoleOnDeath ? ` They were a ${ROLES[victim.role!].name}.` : '';
    out.push(
      this.emit(
        'night_resolved',
        { scope: 'public' },
        victim ? `Dawn breaks. ${victim.publicName} was found dead.${reveal}` : 'Dawn breaks. Nobody died last night.',
        { victim: victim?.id ?? null, victimRole: victim && this.settings.revealRoleOnDeath ? victim.role : undefined },
      ),
    );
    // Hidden details go to a separate admin-only event.
    out.push(
      this.emit('notice', { scope: 'admin' }, 'Night summary (admin).', {
        kind: 'night_summary',
        victim: victim?.id ?? null,
        attempted: murder?.target ?? null,
        killer: murder?.killer ?? null,
        saved: murder && !victim ? murder.target : null,
        choices: { ...s.nightChoices },
      }),
    );

    const win = this.checkWin();
    if (win) out.push(...this.endGame(win.winner, win.reason));
    else out.push(...this.enterPhase('day'));
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
    if (voted >= alive) out.push(...this.resolveDay());
    return out;
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
    if (mafia === 0) return { winner: 'town', reason: 'All murderers have been eliminated. The town wins!' };
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
    return [
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
      const kind = p.role ? ROLES[p.role].nightAction : null;
      if (!kind) return { kind: 'none', done: true, hint: 'You have no night action. Wait for the day.' };
      const options = this.validNightTargets(p).map((t) => t.publicName);
      const choice = s.nightChoices[p.id];
      const verb = kind === 'kill' ? 'kill' : kind === 'protect' ? 'protect' : 'track';
      return {
        kind: 'night_action',
        actionKind: kind,
        options,
        done: !!choice,
        hint: choice
          ? `You chose to ${verb} ${this.player(choice.target)!.publicName}. You may change it until the night ends.`
          : `Choose a player to ${verb} with night_action.`,
      };
    }
    const options = this.alive()
      .filter((t) => t.id !== p.id)
      .map((t) => t.publicName);
    if (this.settings.allowSkipVote) options.push(SKIP);
    const v = s.votes[p.id];
    return {
      kind: 'vote',
      options,
      done: !!v,
      hint: v
        ? `You voted for ${v === SKIP ? SKIP : this.player(v)!.publicName}. You may change your vote until everyone has voted.`
        : 'Discuss, then vote. The day ends when every living player has voted.',
    };
  }

  /** View of the game for a player, or for the admin when viewerId is null. */
  view(viewerId: string | null): PlayerView {
    const s = this.state;
    const isAdmin = viewerId === null;
    const me = viewerId ? this.player(viewerId) ?? null : null;
    const anonymous = this.settings.identityVisibility === 'anonymous';
    const myTeam: Team | null = me?.role ? teamOf(me.role) : null;
    const ended = s.phase === 'ended';

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
        p.id === viewerId ||
        (!p.alive && this.settings.revealRoleOnDeath) ||
        (myTeam === 'mafia' && p.role === 'murderer');
      if (revealed && p.role) {
        pub.role = p.role;
        pub.team = teamOf(p.role);
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
      you: me
        ? {
            id: me.id,
            name: me.publicName,
            role: me.role,
            team: myTeam,
            alive: me.alive,
            roleDescription: me.role ? ROLES[me.role].description : null,
            teammates:
              me.role === 'murderer'
                ? s.players.filter((p) => p.role === 'murderer' && p.id !== me.id).map((p) => p.publicName)
                : [],
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
