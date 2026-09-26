import type { DayActionKind, GameSettings, NightActionKind, RoleId, Team } from './types.ts';

export interface RoleDef {
  id: RoleId;
  name: string;
  /** The team the player really wins with. */
  team: Team;
  nightAction: NightActionKind | null;
  dayAction?: DayActionKind;
  /** Crazy roles: what the player believes to be (and is told). Their actions have no effect. */
  appearsAs?: RoleId;
  /** Shown to the player who holds the role (crazy roles see the description of the role they believe in). */
  description: string;
  /** One line for the lobby's role picker. */
  summary: string;
}

const crazy = (base: 'murderer' | 'doctor' | 'tracker' | 'trapper', name: string, what: string): RoleDef => ({
  id: `crazy_${base}` as RoleId,
  name,
  team: 'town',
  nightAction: ROLES_BASE[base].nightAction as NightActionKind,
  appearsAs: base,
  description: ROLES_BASE[base].description,
  summary: `Believes to be the ${ROLES_BASE[base].name} and gets the same orders, but ${what}. Wins with the town.`,
});

const ROLES_BASE = {
  murderer: {
    id: 'murderer',
    name: 'Murderer',
    team: 'mafia',
    nightAction: 'kill',
    description:
      'You are a MURDERER (mafia). Each night you may kill one player: pick your own victim with night_action, or ' +
      'pass (target "pass") to stay home. Murderers never go to the same house on the same night: if you have partners, ' +
      'split your victims or let one of you pass. You win when the murderers are at least as many as everyone else. ' +
      'During the day, blend in: lie, deflect suspicion and steer the town into eliminating innocent players.',
    summary: 'Mafia. Kills one player per night (or passes). Several murderers never visit the same house.',
  },
  doctor: {
    id: 'doctor',
    name: 'Doctor',
    team: 'town',
    nightAction: 'protect',
    description:
      'You are the DOCTOR (town). Each night you visit one player and protect them: if the murderers attack that player ' +
      'tonight, they survive. You win when all murderers are eliminated.',
    summary: 'Town. Protects one player per night from the murderers.',
  },
  tracker: {
    id: 'tracker',
    name: 'Tracker',
    team: 'town',
    nightAction: 'track',
    description:
      'You are the TRACKER (town detective). Each night you follow one player and learn whose house they visited that night ' +
      '(or that they stayed home). The murderer visits their victim, the doctor visits their patient, the trapper visits ' +
      'the house they trap. You win when all murderers are eliminated.',
    summary: 'Town. Follows one player per night and learns whose house they visited.',
  },
  trapper: {
    id: 'trapper',
    name: 'Trapper',
    team: 'town',
    nightAction: 'trap',
    description:
      'You are the TRAPPER (town). Each night you set a trap in front of one house (your own is allowed, the same house two ' +
      'nights in a row is not). Anyone who comes to that house at night walks into the trap and their action fails: a ' +
      'murderer kills nobody, a doctor protects nobody, a tracker learns nothing. In the morning you learn the role of ' +
      'whoever was caught, but not who it was. The trap catches good and bad roles alike. You win when all murderers are eliminated.',
    summary: 'Town. Traps one house per night: every visitor fails (murderer, doctor, tracker…). Learns the caught role.',
  },
  gunman: {
    id: 'gunman',
    name: 'Gunman',
    team: 'town',
    nightAction: null,
    dayAction: 'shoot',
    description:
      'You are the GUNMAN (town). You have one bullet for the whole game. During the day you may shoot one player with the ' +
      'shoot tool: they die at once and everyone learns that you are the Gunman. Use it wisely: shooting a town player helps ' +
      'the murderers. You win when all murderers are eliminated.',
    summary: 'Town. One bullet: shoots one player during the day, publicly (and reveals themselves).',
  },
  civilian: {
    id: 'civilian',
    name: 'Civilian',
    team: 'town',
    nightAction: null,
    description:
      'You are a CIVILIAN (town). You have no night action. Use discussion and voting during the day to find and ' +
      'eliminate the murderers. You win when all murderers are eliminated.',
    summary: 'Town. No ability: finds the murderers by talking and voting.',
  },
} satisfies Record<string, RoleDef>;

export const ROLES: Record<RoleId, RoleDef> = {
  ...ROLES_BASE,
  crazy_murderer: crazy('murderer', 'Crazy murderer', 'nobody ever dies: they really stay home'),
  crazy_doctor: crazy('doctor', 'Crazy doctor', 'the protection does nothing'),
  crazy_tracker: crazy('tracker', 'Crazy tracker', 'the results are always wrong'),
  crazy_trapper: crazy('trapper', 'Crazy trapper', 'there is no trap and the reports are always wrong'),
};

/** Roles offered in the lobby's role picker, in display order. */
export const ROLE_ORDER: RoleId[] = [
  'murderer',
  'doctor',
  'tracker',
  'trapper',
  'gunman',
  'civilian',
  'crazy_murderer',
  'crazy_doctor',
  'crazy_tracker',
  'crazy_trapper',
];

/** The role a player believes to have (crazy roles are told their apparent role). */
export function apparentRole(role: RoleId): RoleId {
  return ROLES[role].appearsAs ?? role;
}

export function isCrazy(role: RoleId | null | undefined): boolean {
  return !!role && !!ROLES[role].appearsAs;
}

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
  if (settings.roles === 'auto') {
    const counts = settings.roleCounts;
    if (!counts) return defaultRoles(playerCount);
    const roles: RoleId[] = [];
    for (const id of ROLE_ORDER) {
      if (id === 'civilian') continue;
      for (let i = 0; i < (counts[id] ?? 0); i++) roles.push(id);
    }
    if (roles.length > playerCount) {
      throw new Error(`The role setup needs ${roles.length} players but only ${playerCount} joined.`);
    }
    if (!roles.some((r) => teamOf(r) === 'mafia')) throw new Error('The role setup has no murderer.');
    while (roles.length < playerCount) roles.push('civilian');
    return roles;
  }
  if (settings.roles.length !== playerCount) {
    throw new Error(`Role list has ${settings.roles.length} roles but there are ${playerCount} players`);
  }
  return [...settings.roles];
}

export const DEFAULT_SETTINGS: GameSettings = {
  mode: 'classic',
  roles: 'auto',
  roleCounts: null,
  killMode: 'separate',
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
  announceRoles: true,
  maxMessageLength: null,
  maxMessagesPerPhase: null,
  chatCooldownSec: null,
  voteDeadlineSec: 120,
  autoStart: false,
  seats: 0,
  aiPool: true,
};
