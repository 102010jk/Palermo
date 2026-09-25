export type RoleId = 'murderer' | 'doctor' | 'tracker' | 'civilian';
export type Team = 'town' | 'mafia';
export type Phase = 'lobby' | 'night' | 'day' | 'ended';
export type PlayerKind = 'human' | 'ai' | 'bot';
export type Winner = Team | 'draw';

/** What a night role does when it acts. New roles plug in by adding a kind here and handling it in resolveNight. */
export type NightActionKind = 'kill' | 'protect' | 'track';

export interface GameSettings {
  /** Free-form label shown in the UI and usable as a stats filter, e.g. "classic". */
  mode: string;
  /** Explicit role list (length must equal player count) or 'auto' to use the default table. */
  roles: RoleId[] | 'auto';
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
  /** Server starts the game automatically once enough players joined and everyone is ready. */
  autoStart: boolean;
  /** Target seat count used together with autoStart (0 = any count >= minPlayers). */
  seats: number;
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
  death?: { round: number; phase: 'night' | 'day'; cause: 'killed' | 'eliminated' };
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
  /** doctorId -> last protected playerId. */
  lastProtected: Record<string, string>;
  /** doctorIds that already used their one self-protect. */
  selfProtectUsed: string[];
  events: GameEvent[];
  winner: Winner | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** What a specific player is expected (or allowed) to do right now. */
export interface RequiredAction {
  kind: 'ready' | 'night_action' | 'vote' | 'none';
  actionKind?: NightActionKind;
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
  lastEventSeq: number;
}
