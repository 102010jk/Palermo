export type RoleId =
  | 'murderer'
  | 'doctor'
  | 'tracker'
  | 'trapper'
  | 'gunman'
  | 'civilian'
  | 'crazy_murderer'
  | 'crazy_doctor'
  | 'crazy_tracker'
  | 'crazy_trapper';
export type Team = 'town' | 'mafia';
export type Phase = 'lobby' | 'night' | 'day' | 'ended';
export type PlayerKind = 'human' | 'ai' | 'bot';
export type Winner = Team | 'draw';

/** What a night role does when it acts. New roles plug in by adding a kind here and handling it in resolveNight. */
export type NightActionKind = 'kill' | 'protect' | 'track' | 'trap';
/** Actions used during the day (the gunman's single shot). */
export type DayActionKind = 'shoot';

export interface GameSettings {
  /** Free-form label shown in the UI and usable as a stats filter, e.g. "classic". */
  mode: string;
  /** Explicit role list (length must equal player count) or 'auto' to use the default table / roleCounts. */
  roles: RoleId[] | 'auto';
  /**
   * With roles 'auto': how many of each special role (the rest are civilians). null = default table by player count.
   */
  roleCounts: Partial<Record<RoleId, number>> | null;
  /**
   * 'separate': every murderer picks their own victim (never the same house as a partner) or passes;
   * 'shared': the murderers agree on one victim per night (older games).
   */
  killMode: 'separate' | 'shared';
  /**
   * 'visual': paced for people watching or playing (one chat message at a time, night visits played out for the
   * god view, days last a little); 'simulation': as fast as the players are.
   */
  gameStyle: 'visual' | 'simulation';
  startPhase: 'night' | 'day';
  /** Reveal the role of a player when they die. */
  revealRoleOnDeath: boolean;
  /** Everyone sees who voted for whom. Otherwise only counts are revealed at the end of the day. */
  publicVotes: boolean;
  /** Allow voting "skip" (nobody gets eliminated). */
  allowSkipVote: boolean;
  /** Whether players can see which model / provider / human is behind each seat. */
  identityVisibility: 'visible' | 'anonymous';
  /** Which accumulated notes an AI may read before the game: none, notes of its own model, or all notes. */
  notesMode: 'none' | 'own' | 'shared';
  /** "No rules" mode: agents get full tool access (web, shell) inside their sandbox. Recorded for stats. */
  freedomMode: boolean;
  doctorSelfProtect: 'never' | 'once' | 'always';
  /** Doctor may not protect the same player two nights in a row. */
  doctorNoRepeat: boolean;
  /** Doctor privately learns when their patient was attacked and saved. */
  doctorLearnsSave: boolean;
  /** null = no time limit. */
  nightTimeoutSec: number | null;
  /** null = the day lasts until every living player has voted. */
  dayTimeoutSec: number | null;
  /** Safety cap on rounds; the game ends in a draw after this. null = unlimited. */
  maxRounds: number | null;
  minPlayers: number;
  /** Tell everyone at the start how many of each role are in play. */
  announceRoles: boolean;
  /** Chat limits (null = off). Max characters per message. */
  maxMessageLength: number | null;
  /** Max chat messages per player per phase (a day, or a night for the murderers' private chat). */
  maxMessagesPerPhase: number | null;
  /** Minimum seconds between two messages of the same player (anti-spam). */
  chatCooldownSec: number | null;
  /**
   * Stall guard: once two thirds of the living players have voted, the day ends after this many seconds without a
   * chat message (at most VOTE_DEADLINE_CAP_SEC after it started) with the votes cast so far. null = off.
   */
  voteDeadlineSec: number | null;
  /** Server starts the game automatically once enough players joined and everyone is ready. */
  autoStart: boolean;
  /** Target seat count used together with autoStart (0 = any count >= minPlayers). */
  seats: number;
  /** AI players from the waiting list (AI players page + agents.bat) may take free seats. */
  aiPool: boolean;
}

export interface PlayerInput {
  id: string;
  name: string;
  kind: PlayerKind;
  provider?: string;
  model?: string;
  /** Model identity was set by a trusted launcher (runner), not self-reported. */
  verified?: boolean;
  /** Stable account id (human account or AI agent identity) for statistics. */
  accountId?: string;
}

export interface Player extends PlayerInput {
  /** Name shown to other players. Equals `name` unless the game is anonymous. */
  publicName: string;
  verified: boolean;
  role: RoleId | null;
  alive: boolean;
  ready: boolean;
  death?: { round: number; phase: 'night' | 'day'; cause: 'killed' | 'eliminated' | 'shot' };
}

export type Visibility =
  | { scope: 'public' }
  | { scope: 'players'; ids: string[] }
  | { scope: 'team'; team: Team }
  | { scope: 'admin' };

export type EventType =
  | 'player_joined'
  | 'player_left'
  | 'player_ready'
  | 'game_started'
  | 'role_assigned'
  | 'phase_changed'
  | 'chat'
  | 'team_chat'
  | 'vote'
  | 'day_resolved'
  | 'night_action'
  | 'night_resolved'
  | 'tracker_result'
  | 'doctor_result'
  | 'trap_result'
  | 'shot'
  | 'thought'
  | 'notice'
  | 'game_ended';

export interface GameEvent {
  seq: number;
  at: number;
  round: number;
  phase: Phase;
  type: EventType;
  vis: Visibility;
  /** Player who caused the event, if any. */
  actor?: string;
  /** Short human-readable description (English), safe to show to anyone who can see the event. */
  text: string;
  data: Record<string, unknown>;
}

export interface NightChoice {
  kind: NightActionKind;
  target: string;
  at: number;
}

export interface GameState {
  id: string;
  settings: GameSettings;
  seed: number;
  rngState: number;
  phase: Phase;
  round: number;
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  players: Player[];
  /** playerId -> choice for the current night. */
  nightChoices: Record<string, NightChoice>;
  /** playerId -> target playerId or 'skip' for the current day. */
  votes: Record<string, string>;
  /** Set once the vote deadline started this day (see settings.voteDeadlineSec). */
  voteDeadlineAt?: number | null;
  voteDeadlineStartedAt?: number | null;
  /** Visual games: chat messages waiting to be spoken, and until when the current one is on screen. */
  speechQueue?: { playerId: string; text: string }[];
  floorUntil?: number | null;
  /** Visual games: the night is being played out (actions locked) and resolves at phaseEndsAt. */
  nightPlanned?: boolean;
  /** Visual games: everyone voted, the day ends at phaseEndsAt. */
  dayClosing?: boolean;
  /** playerId -> chat messages sent in the current phase (for chat limits). */
  messagesThisPhase?: Record<string, number>;
  /** playerId -> time of the last chat message (for the cooldown). */
  lastMessageAt?: Record<string, number>;
  /** doctorId -> last protected playerId. */
  lastProtected: Record<string, string>;
  /** doctorIds that already used their one self-protect. */
  selfProtectUsed: string[];
  /** trapperId -> house trapped last night (no trap on the same house two nights in a row). */
  lastTrapped?: Record<string, string>;
  /** gunmanId -> shots fired (one bullet per game). */
  shotsFired?: Record<string, number>;
  /** Players whose role everyone knows (e.g. a gunman after shooting). */
  revealed?: string[];
  /** Game paused (e.g. a provider's usage limit ran out): timers are frozen until it resumes. */
  pausedAt?: number | null;
  pauseReason?: string | null;
  /** Accounts the game waits for (e.g. out of usage): it resumes once all of them are back. */
  pausedBy?: string[];
  events: GameEvent[];
  winner: Winner | null;
  /** Stopped by the host (or the runner): not a real result, excluded from statistics. */
  aborted?: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** What a specific player is expected (or allowed) to do right now. */
export interface RequiredAction {
  kind: 'ready' | 'night_action' | 'vote' | 'none';
  actionKind?: NightActionKind;
  /** Extra action available right now (the gunman's shot during the day). */
  dayAction?: { kind: DayActionKind; options: string[] };
  /** Valid targets as public names. */
  options?: string[];
  done: boolean;
  hint: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  alive: boolean;
  ready: boolean;
  kind?: PlayerKind;
  provider?: string;
  model?: string;
  verified?: boolean;
  role?: RoleId;
  team?: Team;
  death?: Player['death'];
  /** Present for admins in anonymous games: the real name behind the alias. */
  realName?: string;
}

export interface PlayerView {
  gameId: string;
  phase: Phase;
  round: number;
  phaseEndsAt: number | null;
  settings: GameSettings;
  winner: Winner | null;
  isAdmin: boolean;
  paused: { since: number; reason: string } | null;
  you: {
    id: string;
    name: string;
    role: RoleId | null;
    team: Team | null;
    alive: boolean;
    roleDescription: string | null;
    teammates: string[];
  } | null;
  players: PublicPlayer[];
  /** voterName -> target name or 'skip'. Only filled when votes are visible to the viewer. */
  votes: Record<string, string>;
  votedCount: number;
  aliveCount: number;
  required: RequiredAction;
  /** Chat limits for the viewer: null fields mean "no limit". */
  chat: { maxLength: number | null; left: number | null; cooldownUntil: number | null };
  lastEventSeq: number;
}
