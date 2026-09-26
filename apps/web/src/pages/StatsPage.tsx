import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.ts';

interface Bucket {
  key: string;
  label: string;
  games: number;
  distinctGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  survived: number;
  byRole: Record<string, { games: number; wins: number }>;
  voteAccuracy: number | null;
  townVotes: number;
  kills: number;
  messages: number;
  avgMessageLength: number | null;
  tokensIn: number;
  tokensOut: number;
}

interface Stats {
  games: number;
  winners: Record<string, number>;
  avgRounds: number | null;
  byModel: Bucket[];
  byRole: { role: string; games: number; wins: number; winRate: number | null }[];
  timeline: { gameIndex: number; gameId: string; rates: Record<string, number> }[];
  settingValues: Record<string, string[]>;
}

/** Categorical slots, dark steps (validated against the card surface). Assigned by entity, never by rank. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const TOWN = SERIES[0];
const MAFIA = SERIES[1];

const FILTERS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'lineupKind', label: 'Line-up type' },
  { key: 'lineup', label: 'Exact line-up', wide: true },
  { key: 'withHumans', label: 'Humans' },
  { key: 'mode', label: 'Mode' },
  { key: 'identityVisibility', label: 'Identities' },
  { key: 'notesMode', label: 'Notes' },
  { key: 'freedomMode', label: 'No-rules' },
  { key: 'startPhase', label: 'Starts with' },
  { key: 'revealRoleOnDeath', label: 'Role reveal' },
  { key: 'publicVotes', label: 'Public votes' },
  { key: 'announceRoles', label: 'Roles announced' },
  { key: 'maxMessageLength', label: 'Max msg length' },
  { key: 'maxMessagesPerPhase', label: 'Msgs per day' },
  { key: 'chatCooldownSec', label: 'Chat cooldown' },
];

const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function useStats(filters: Record<string, string>, players: string) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(`s.${k}`, v);
    if (players) q.set('players', players);
    api<Stats>('GET', `/api/stats?${q}`)
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [JSON.stringify(filters), players]);
  return { stats, error };
}

function Filters({
  values,
  filters,
  setFilter,
  players,
  setPlayers,
}: {
  values: Record<string, string[]>;
  filters: Record<string, string>;
  setFilter: (k: string, v: string) => void;
  players: string;
  setPlayers: (v: string) => void;
}) {
  return (
    <div className="filters">
      {FILTERS.map((f) => (
        <label key={f.key} className={f.wide ? 'wide' : undefined}>
          {f.label}
          <select value={filters[f.key] ?? ''} onChange={(e) => setFilter(f.key, e.target.value)}>
            <option value="">any</option>
            {(values[f.key] ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label>
        Players
        <input type="number" min={3} placeholder="any" value={players} onChange={(e) => setPlayers(e.target.value)} />
      </label>
    </div>
  );
}

function Panel({ title, colorIndexByKey }: { title?: string; colorIndexByKey: (key: string) => number }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [players, setPlayers] = useState('');
  const { stats, error } = useStats(filters, players);
  const [showTable, setShowTable] = useState(true);

  const models = useMemo(() => stats?.byModel ?? [], [stats]);
  const barData = models
    .filter((b) => b.wins + b.losses > 0)
    .map((b) => ({
      name: b.label,
      winRate: Math.round((b.winRate ?? 0) * 100),
      town: roleRate(b, false),
      mafia: roleRate(b, true),
      games: b.games,
    }));
  const lineModels = models.filter((m) => m.key !== 'bot').slice(0, 8);
  const lineData = (stats?.timeline ?? []).map((t) => {
    const row: Record<string, number> = { game: t.gameIndex };
    for (const m of lineModels) if (t.rates[m.label] != null) row[m.label] = Math.round(t.rates[m.label] * 100);
    return row;
  });

  return (
    <section className="card stats-panel">
      {title && <h2>{title}</h2>}
      <Filters
        values={stats?.settingValues ?? {}}
        filters={filters}
        setFilter={(k, v) => setFilters((f) => ({ ...f, [k]: v }))}
        players={players}
        setPlayers={setPlayers}
      />
      {error && <p className="error">{error}</p>}
      {stats && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Games</span>
              <span className="tile-value">{stats.games}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Town wins</span>
              <span className="tile-value">{stats.games ? pct((stats.winners.town ?? 0) / stats.games) : '–'}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Murderer wins</span>
              <span className="tile-value">{stats.games ? pct((stats.winners.mafia ?? 0) / stats.games) : '–'}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Avg rounds</span>
              <span className="tile-value">{stats.avgRounds?.toFixed(1) ?? '–'}</span>
            </div>
          </div>

          {!stats.games && <p className="muted">No finished games match these filters yet.</p>}

          {barData.length > 0 && (
            <figure className="chart">
              <figcaption>Win rate by model, as town vs as murderer (%)</figcaption>
              <ResponsiveContainer width="100%" height={Math.max(180, barData.length * 46 + 60)}>
                <BarChart data={barData} layout="vertical" margin={{ left: 12, right: 24 }} barGap={2}>
                  <CartesianGrid horizontal={false} stroke="var(--grid)" />
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--grid)" />
                  <YAxis type="category" dataKey="name" width={160} tick={{ fill: 'var(--text)', fontSize: 12 }} stroke="var(--grid)" />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    contentStyle={{ background: 'var(--card-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
                    formatter={(v: unknown, n: unknown) => [`${v}%`, n === 'town' ? 'as town' : 'as murderer']}
                  />
                  <Legend formatter={(v) => <span style={{ color: 'var(--text)' }}>{v === 'town' ? 'as town' : 'as murderer'}</span>} />
                  <Bar dataKey="town" fill={TOWN} radius={[0, 4, 4, 0]} barSize={14} />
                  <Bar dataKey="mafia" fill={MAFIA} radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </figure>
          )}

          {lineData.length > 1 && lineModels.length > 0 && (
            <figure className="chart">
              <figcaption>Cumulative win rate over games (%)</figcaption>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={lineData} margin={{ left: 0, right: 24, top: 8 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="game" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--grid)" />
                  <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--grid)" />
                  <Tooltip contentStyle={{ background: 'var(--card-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                  <Legend formatter={(v) => <span style={{ color: 'var(--text)' }}>{v}</span>} />
                  {lineModels.map((m) => (
                    <Line
                      key={m.key}
                      dataKey={m.label}
                      stroke={SERIES[colorIndexByKey(m.key) % SERIES.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </figure>
          )}

          <div className="row">
            <button className="ghost small" onClick={() => setShowTable((x) => !x)}>
              {showTable ? 'Hide table' : 'Show table'}
            </button>
          </div>
          {showTable && models.length > 0 && (
            <div className="table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Player / model</th>
                    <th title="Games the model took part in">Games</th>
                    <th title="Seats played: 4 Sonnets in one game count as 4">Seats</th>
                    <th>Win rate</th>
                    <th>As town</th>
                    <th>As murderer</th>
                    <th>Survived</th>
                    <th title="Share of day votes by town players that hit a murderer">Vote accuracy</th>
                    <th>Kills</th>
                    <th>Messages</th>
                    <th>Avg length</th>
                    <th>Tokens in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((b) => (
                    <tr key={b.key}>
                      <td>{b.label}</td>
                      <td>{b.distinctGames}</td>
                      <td>{b.games}</td>
                      <td>{pct(b.winRate)}</td>
                      <td>{rateText(b, false)}</td>
                      <td>{rateText(b, true)}</td>
                      <td>{pct(b.games ? b.survived / b.games : null)}</td>
                      <td>{pct(b.voteAccuracy)}</td>
                      <td>{b.kills}</td>
                      <td>{b.messages}</td>
                      <td>{b.avgMessageLength ? Math.round(b.avgMessageLength) : '–'}</td>
                      <td>
                        {b.tokensIn ? `${fmtK(b.tokensIn)} / ${fmtK(b.tokensOut)}` : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">
                Small samples lie: with n games, a win rate is only accurate to roughly ±{stats.games ? Math.round(100 / Math.sqrt(Math.max(1, stats.games))) : '–'} points.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function roleRate(b: Bucket, mafia: boolean): number {
  let g = 0;
  let w = 0;
  for (const [role, v] of Object.entries(b.byRole)) {
    if ((role === 'murderer') === mafia) {
      g += v.games;
      w += v.wins;
    }
  }
  return g ? Math.round((w / g) * 100) : 0;
}

function rateText(b: Bucket, mafia: boolean): string {
  let g = 0;
  let w = 0;
  for (const [role, v] of Object.entries(b.byRole)) {
    if ((role === 'murderer') === mafia) {
      g += v.games;
      w += v.wins;
    }
  }
  return g ? `${Math.round((w / g) * 100)}% (${g})` : '–';
}

function fmtK(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

export function StatsPage() {
  const [compare, setCompare] = useState(false);
  // Stable color per model across both panels: first-seen order, never re-ranked.
  const order = useMemo(() => new Map<string, number>(), []);
  const colorIndexByKey = (key: string) => {
    if (!order.has(key)) order.set(key, order.size);
    return order.get(key)!;
  };
  return (
    <div className="stats">
      <div className="stats-head">
        <h1>Statistics</h1>
        <label className="check">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare two setups (A/B)
        </label>
      </div>
      <p className="muted">
        Every game stores its full settings and its line-up, so experiments never mix: a 4× Sonnet + 2× Haiku game is a different
        experiment from a Claude vs GPT vs Gemini game. Filter by line-up, identity visibility, notes, no-rules mode and more.
      </p>
      <div className={compare ? 'compare' : ''}>
        <Panel title={compare ? 'A' : undefined} colorIndexByKey={colorIndexByKey} />
        {compare && <Panel title="B" colorIndexByKey={colorIndexByKey} />}
      </div>
    </div>
  );
}
