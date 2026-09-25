import type { GameSettings, NightActionKind, RoleId, Team } from './types.ts';

export interface RoleDef {
  id: RoleId;
  name: string;
  team: Team;
  nightAction: NightActionKind | null;
  /** Shown to the player who holds the role. */
  description: string;
}

export const ROLES: Record<RoleId, RoleDef> = {
  murderer: {
    id: 'murderer',
    name: 'Murderer',
    team: 'mafia',
    nightAction: 'kill',
    description:
      'You are a MURDERER (mafia). Each night you choose one player to kill. If there are several murderers, you know each ' +
      'other, can talk privately at night, and the kill goes to the target most of you picked. You win when the murderers ' +
      'are at least as many as everyone else. During the day, blend in: lie, deflect suspicion and steer the town into ' +
      'eliminating innocent players.',
  },
  doctor: {
    id: 'doctor',
    name: 'Doctor',
    team: 'town',
    nightAction: 'protect',
    description:
      'You are the DOCTOR (town). Each night you visit one player and protect them: if the murderers attack that player ' +
      'tonight, they survive. You win when all murderers are eliminated.',
  },
  tracker: {
    id: 'tracker',
    name: 'Tracker',
    team: 'town',
    nightAction: 'track',
    description:
      'You are the TRACKER (town detective). Each night you follow one player and learn whose house they visited that night ' +
      '(or that they stayed home). The murderer visits their victim, the doctor visits their patient. You win when all ' +
      'murderers are eliminated.',
  },
  civilian: {
    id: 'civilian',
    name: 'Civilian',
    team: 'town',
    nightAction: null,
    description:
      'You are a CIVILIAN (town). You have no night action. Use discussion and voting during the day to find and ' +
      'eliminate the murderers. You win when all murderers are eliminated.',
  },
};

export function teamOf(role: RoleId): Team {
  return ROLES[role].team;
}

/** Default role table by player count. */
export function defaultRoles(playerCount: number): RoleId[] {
  const n = playerCount;
  let murderers: number;
  if (n <= 6) murderers = 1;
  else if (n <= 10) murderers = 2;
  else if (n <= 14) murderers = 3;
  else murderers = Math.floor(n / 4.5);

  const roles: RoleId[] = [];
  for (let i = 0; i < murderers; i++) roles.push('murderer');
  if (n >= 3) roles.push('doctor');
  if (n >= 5) roles.push('tracker');
  while (roles.length < n) roles.push('civilian');
  return roles.slice(0, n);
}

export function rolesFor(settings: GameSettings, playerCount: number): RoleId[] {
  if (settings.roles === 'auto') return defaultRoles(playerCount);
  if (settings.roles.length !== playerCount) {
    throw new Error(`Role list has ${settings.roles.length} roles but there are ${playerCount} players`);
  }
  return [...settings.roles];
}

export const DEFAULT_SETTINGS: GameSettings = {
  mode: 'classic',
  roles: 'auto',
  startPhase: 'night',
  revealRoleOnDeath: true,
  publicVotes: true,
  allowSkipVote: true,
  identityVisibility: 'visible',
  notesMode: 'own',
  freedomMode: false,
  doctorSelfProtect: 'once',
  doctorNoRepeat: true,
  doctorLearnsSave: true,
  nightTimeoutSec: 180,
  dayTimeoutSec: null,
  maxRounds: 15,
  minPlayers: 3,
  autoStart: false,
  seats: 0,
};
