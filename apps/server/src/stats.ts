import { ROLE_INFO_LABEL, ROLE_ORDER, ROLES, roleInfoOf, teamOf, type GameSettings, type RoleId } from '@palermo/engine';
import type { Db } from './db.ts';

const isMafia = (role: string | undefined) => !!role && teamOf(role as RoleId) === 'mafia';

/**
 * Aggregate statistics over finished games. Every game stores its full settings snapshot, so any setting
 * can be used as a filter (e.g. identityVisibility=anonymous & notesMode=none) to keep experiments separate.
 */

export interface StatsFilter {
  /** settings key -> required value (string compare) */
  settings: Record<string, string>;
  playerCount?: number;
  since?: number;
  until?: number;
}

export interface Bucket {
  key: string;
  label: string;
  games: number;
  /** Distinct games this model took part in (games counts seats: 4 Sonnets in one game = 4). */
  distinctGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  survived: number;
  byRole: Record<string, { games: number; wins: number }>;
  /** Votes cast (final votes of the day) by town-aligned players, and how many hit a murderer. */
  townVotes: number;
  townVotesOnMafia: number;
  voteAccuracy: number | null;
  /** As murderer: nights where the chosen victim actually died. */
  kills: number;
  messages: number;
  avgMessageLength: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface StatsResult {
  games: number;
  winners: Record<string, number>;
  avgRounds: number | null;
  byModel: Bucket[];
  byRole: { role: string; games: number; wins: number; winRate: number | null }[];
  /** Win rate over time: per model cumulative after each game (ordered by game end). */
  timeline: { gameIndex: number; gameId: string; endedAt: number; rates: Record<string, number> }[];
  settingValues: Record<string, string[]>;
}

type Row = Record<string, unknown>;

/** Scripted players: server-side bots and the runner's MCP bots (provider "script"). */
export function isBot(p: { kind: string; provider: string | null; model?: string | null }): boolean {
  return p.kind === 'bot' || p.provider === 'script' || p.model === 'random-bot';
}

export function modelLabel(p: { kind: string; provider: string | null; model: string | null; name: string; account_id?: string | null }): { key: string; label: string } {
  if (p.kind === 'human') return { key: `human:${p.account_id ?? p.name}`, label: `${p.name} (human)` };
  if (isBot(p)) return { key: 'bot', label: 'Scripted bot' };
  // Drop date stamps from labels: "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
  if (p.model) return { key: `${p.provider ?? '?'}:${p.model}`, label: p.model.replace(/-\d{8}$/, '') };
  return { key: `agent:${p.name}`, label: `${p.name} (unknown model)` };
}

/**
 * Attributes derived from who actually sat at the table. They are filterable like settings, so e.g.
 * "4x Sonnet + 2x Haiku" games never mix with multi-provider games.
 */
export function lineupOf(players: Row[]): { lineup: string; lineupKind: string; withHumans: string; roleSetup: string } {
  const counts = new Map<string, number>();
  const providers = new Set<string>();
  const models = new Set<string>();
  let humans = 0;
  for (const p of players) {
    if (p.kind === 'human') {
      humans++;
      continue;
    }
    const { key, label } = modelLabel(p as never);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    providers.add(key.split(':')[0]);
    models.add(key);
  }
  const parts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([l, n]) => `${l} ×${n}`);
  if (humans) parts.push(`human ×${humans}`);
  const lineupKind = models.size <= 1 ? 'single-model' : providers.size === 1 ? 'single-provider' : 'multi-provider';
  // The roles that were really in play, e.g. "Murderer ×2 + Doctor + Trapper + Civilian ×5".
  const roleCounts = new Map<string, number>();
  for (const p of players) if (p.role) roleCounts.set(p.role as string, (roleCounts.get(p.role as string) ?? 0) + 1);
  const roleSetup = ROLE_ORDER.filter((r) => roleCounts.has(r))
    .map((r) => `${ROLES[r].name}${roleCounts.get(r)! > 1 ? ` ×${roleCounts.get(r)}` : ''}`)
    .join(' + ');
  return { lineup: parts.join(' + '), lineupKind, withHumans: humans ? 'yes' : 'no', roleSetup };
}

function matches(settings: GameSettings, row: Row, f: StatsFilter, derived: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(f.settings)) {
    if (v === '' || v === undefined) continue;
    const actual = k in derived ? derived[k] : (settings as unknown as Record<string, unknown>)[k];
    const s = Array.isArray(actual) ? actual.join(',') : String(actual);
    if (s !== v) return false;
  }
  if (f.playerCount && Number(row.player_count) !== f.playerCount) return false;
  if (f.since && Number(row.ended_at) < f.since) return false;
  if (f.until && Number(row.ended_at) > f.until) return false;
  return true;
}

export function computeStats(db: Db, filter: StatsFilter = { settings: {} }): StatsResult {
  const playersStmt = db.sql.prepare('SELECT * FROM game_players WHERE game_id = ?');
  // Games stopped by the host are not results.
  // Not results: games stopped by the host, and test games where only scripted bots played.
  const allEnded = (db.sql.prepare("SELECT * FROM games WHERE phase = 'ended' ORDER BY ended_at").all() as Row[]).filter(
    (g) =>
      !(JSON.parse(g.state as string) as { aborted?: boolean }).aborted &&
      (playersStmt.all(g.id as string) as Row[]).some((p) => !isBot(p as never)),
  );
  const derivedOf = new Map(
    allEnded.map((g) => [
      g.id as string,
      { ...lineupOf(playersStmt.all(g.id as string) as Row[]), roleInfo: ROLE_INFO_LABEL[roleInfoOf(JSON.parse(g.settings as string))] },
    ]),
  );

  const settingValues: Record<string, Set<string>> = {};
  for (const g of allEnded) {
    const s = { ...(JSON.parse(g.settings as string) as Record<string, unknown>), ...derivedOf.get(g.id as string) };
    for (const [k, v] of Object.entries(s)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) continue;
      (settingValues[k] ??= new Set()).add(Array.isArray(v) ? v.join(',') : String(v));
    }
  }

  const games = allEnded.filter((g) => matches(JSON.parse(g.settings as string), g, filter, derivedOf.get(g.id as string)!));

  const buckets = new Map<string, Bucket>();
  const roleAgg = new Map<string, { games: number; wins: number }>();
  const winners: Record<string, number> = {};
  const timeline: StatsResult['timeline'] = [];
  let roundsSum = 0;

  const bucket = (key: string, label: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        key, label, games: 0, distinctGames: 0, wins: 0, losses: 0, draws: 0, winRate: null, survived: 0, byRole: {},
        townVotes: 0, townVotesOnMafia: 0, voteAccuracy: null, kills: 0, messages: 0, avgMessageLength: null,
        tokensIn: 0, tokensOut: 0, costUsd: 0,
      };
      buckets.set(key, b);
    }
    return b;
  };
  const msgLen = new Map<string, number>();

  const eventsStmt = db.sql.prepare(
    "SELECT seq, type, actor, data, round FROM events WHERE game_id = ? AND type IN ('chat','notice')",
  );
  const usageStmt = db.sql.prepare(
    'SELECT account_id, SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS tin, SUM(output_tokens) AS tout, SUM(COALESCE(cost_usd,0)) AS cost FROM usage WHERE game_id = ? GROUP BY account_id',
  );

  games.forEach((g, i) => {
    const gid = g.id as string;
    const winner = (g.winner as string) ?? 'draw';
    winners[winner] = (winners[winner] ?? 0) + 1;
    const state = JSON.parse(g.state as string) as { round: number };
    roundsSum += state.round ?? 0;

    const players = playersStmt.all(gid) as Row[];
    const byPlayer = new Map<string, Bucket>();
    const seenHere = new Set<string>();
    for (const p of players) {
      const { key, label } = modelLabel(p as never);
      const b = bucket(key, label);
      byPlayer.set(p.player_id as string, b);
      b.games++;
      if (!seenHere.has(key)) {
        seenHere.add(key);
        b.distinctGames++;
      }
      if (p.won === 1) b.wins++;
      else if (p.won === 0) b.losses++;
      else b.draws++;
      if (p.survived === 1) b.survived++;
      const role = (p.role as string) ?? '?';
      const br = (b.byRole[role] ??= { games: 0, wins: 0 });
      br.games++;
      if (p.won === 1) br.wins++;
      const ra = roleAgg.get(role) ?? { games: 0, wins: 0 };
      ra.games++;
      if (p.won === 1) ra.wins++;
      roleAgg.set(role, ra);
    }
    const roleOf = new Map(players.map((p) => [p.player_id as string, p.role as string]));

    const rows = eventsStmt.all(gid) as Row[];
    // Ventriloquist lines are shown in someone else's name: count them for the real author.
    const forgedBy = new Map<number, string>();
    for (const e of rows) {
      if (e.type !== 'notice') continue;
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      if (data.kind === 'forged') forgedBy.set(Number(data.chatSeq), String(data.by));
    }
    for (const e of rows) {
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      if (e.type === 'chat' && e.actor) {
        const b = byPlayer.get(forgedBy.get(Number(e.seq)) ?? (e.actor as string));
        if (b) {
          b.messages++;
          msgLen.set(b.key, (msgLen.get(b.key) ?? 0) + String(data.message ?? '').length);
        }
      } else if (e.type === 'notice' && data.kind === 'day_votes') {
        for (const [voter, target] of Object.entries(data.votes as Record<string, string>)) {
          if (isMafia(roleOf.get(voter))) continue;
          const b = byPlayer.get(voter);
          if (!b || target === 'skip') continue;
          b.townVotes++;
          if (isMafia(roleOf.get(target))) b.townVotesOnMafia++;
        }
      } else if (e.type === 'notice' && data.kind === 'night_summary' && Array.isArray(data.visits)) {
        const dead = new Set((data.victims as string[] | undefined) ?? []);
        for (const v of data.visits as { from: string; to: string; kind: string; crazy: boolean; caught: boolean }[]) {
          if (v.kind !== 'kill' || v.crazy || v.caught || !dead.has(v.to)) continue;
          const kb = byPlayer.get(v.from);
          if (kb) kb.kills++;
        }
      } else if (e.type === 'notice' && data.kind === 'night_summary' && data.victim && data.killer) {
        const kb = byPlayer.get(data.killer as string);
        if (kb) kb.kills++;
      }
    }

    const acctBucket = new Map(players.filter((p) => p.account_id).map((p) => [p.account_id as string, byPlayer.get(p.player_id as string)!]));
    for (const u of usageStmt.all(gid) as Row[]) {
      const b = acctBucket.get(u.account_id as string);
      if (!b) continue;
      b.tokensIn += Number(u.tin ?? 0);
      b.tokensOut += Number(u.tout ?? 0);
      b.costUsd += Number(u.cost ?? 0);
    }

    const rates: Record<string, number> = {};
    for (const b of buckets.values()) if (b.wins + b.losses) rates[b.label] = b.wins / (b.wins + b.losses);
    timeline.push({ gameIndex: i + 1, gameId: gid, endedAt: Number(g.ended_at), rates });
  });

  for (const b of buckets.values()) {
    b.winRate = b.wins + b.losses ? b.wins / (b.wins + b.losses) : null;
    b.voteAccuracy = b.townVotes ? b.townVotesOnMafia / b.townVotes : null;
    b.avgMessageLength = b.messages ? (msgLen.get(b.key) ?? 0) / b.messages : null;
  }

  return {
    games: games.length,
    winners,
    avgRounds: games.length ? roundsSum / games.length : null,
    byModel: [...buckets.values()].sort((a, b) => b.games - a.games),
    byRole: [...roleAgg.entries()].map(([role, v]) => ({ role, ...v, winRate: v.games ? v.wins / v.games : null })),
    timeline,
    settingValues: Object.fromEntries(Object.entries(settingValues).map(([k, v]) => [k, [...v].sort()])),
  };
}
