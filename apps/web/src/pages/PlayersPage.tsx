import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Link, useApp } from '../App.tsx';
import { Character, lookFor } from '../components/Sprites.tsx';

type Provider = 'claude' | 'codex' | 'agy' | 'gemini' | 'bot';

interface CatalogEntry {
  provider: Provider;
  model: string;
  label: string;
}

interface Pick extends CatalogEntry {
  id: string;
  name: string;
  repeat: boolean;
  status: 'waiting' | 'joining' | 'playing' | 'error';
  gameId?: string;
  error?: string;
  games: number;
  since: number;
}

interface PoolStatus {
  online: boolean;
  launcher: { host: string; lastSeen: number } | null;
  catalog: CatalogEntry[];
  picks: Pick[];
  lobbies: { id: string; mode: string; players: number; seats: number; free: number }[];
}

const GROUPS: { provider: Provider; title: string }[] = [
  { provider: 'claude', title: 'Claude Code' },
  { provider: 'codex', title: 'Codex (GPT)' },
  { provider: 'agy', title: 'Antigravity (agy)' },
  { provider: 'gemini', title: 'Gemini CLI' },
  { provider: 'bot', title: 'Bots' },
];

const COMPANY: Record<Provider, string> = { claude: 'anthropic', codex: 'openai', agy: 'google', gemini: 'google', bot: 'script' };

const look = (e: CatalogEntry) => lookFor({ kind: e.provider === 'bot' ? 'bot' : 'ai', provider: COMPANY[e.provider], model: e.model });

const STATUS: Record<Pick['status'], string> = { waiting: 'waiting for a lobby', joining: 'joining', playing: 'playing', error: 'error' };

export function PlayersPage() {
  const { isAdmin } = useApp();
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [repeat, setRepeat] = useState(true);

  const call = (method: string, path: string, body?: unknown) =>
    api<PoolStatus>(method, path, body, { admin: true })
      .then((p) => {
        setPool(p);
        setError(null);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    if (!isAdmin) return;
    call('GET', '/api/admin/pool');
    const t = setInterval(() => call('GET', '/api/admin/pool'), 3000);
    return () => clearInterval(t);
  }, [isAdmin]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const entries = (pool?.catalog ?? []).filter((e) => !q || `${e.label} ${e.model}`.toLowerCase().includes(q));
    return GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => e.provider === g.provider) })).filter((g) => g.entries.length);
  }, [pool?.catalog, filter]);

  if (!isAdmin) return <div className="card">Game master only. Unlock with the admin token on the home page.</div>;
  if (!pool) return <div className="loading">{error ?? 'Loading…'}</div>;

  const add = (e: CatalogEntry) => call('POST', '/api/admin/pool/picks', { ...e, repeat });
  const waiting = pool.picks.filter((p) => p.status === 'waiting').length;
  const freeSeats = pool.lobbies.reduce((n, l) => n + (l.seats ? l.free : 0), 0);

  return (
    <div className="players-page">
      <section className={`card launcher ${pool.online ? 'on' : 'off'}`}>
        <span className="phase-dot" />
        {pool.online ? (
          <span>
            AI launcher running on <b>{pool.launcher?.host}</b>. Picked players join the first lobby with free seats.
          </span>
        ) : (
          <span>
            AI launcher is <b>offline</b>. Start <code>agents.bat</code> on the PC with the logged-in CLIs; picks wait until it runs.
          </span>
        )}
        <span className="muted small">
          {pool.lobbies.length
            ? `Open lobbies: ${pool.lobbies.map((l) => `${l.id} (${l.players}/${l.seats || '∞'})`).join(', ')}`
            : 'No open lobby. Create one on the Games page (AI players may join is on by default).'}
        </span>
      </section>
      {error && <p className="error">{error}</p>}

      <div className="players-grid">
        <section className="card">
          <h2>Models</h2>
          <div className="row wrap">
            <input placeholder="Filter (e.g. flash, sol)" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> keep playing (rejoin the next lobby)
            </label>
          </div>
          {!pool.catalog.length && (
            <p className="muted">The model list comes from the AI launcher. Start agents.bat once and it appears here.</p>
          )}
          {groups.map((g) => (
            <div key={g.provider} className="catalog-group">
              <h3>{g.title}</h3>
              {g.entries.map((e) => (
                <button key={`${e.provider}:${e.model}`} className="catalog-item" onClick={() => add(e)} title={`Add ${e.model}`}>
                  <Character look={look(e)} scale={2} />
                  <span className="catalog-label">
                    {e.label}
                    <span className="muted small">{e.model}</span>
                  </span>
                  <span className="catalog-add">+</span>
                </button>
              ))}
            </div>
          ))}
        </section>

        <section className="card">
          <h2>
            Waiting list <span className="muted small">({waiting} waiting{freeSeats ? `, ${freeSeats} free seats` : ''})</span>
          </h2>
          {!pool.picks.length && <p className="muted">Click models on the left to add players. The same model can be added several times.</p>}
          <table className="mini-table picks">
            <tbody>
              {pool.picks.map((p) => (
                <tr key={p.id} className={`pick ${p.status}`}>
                  <td>
                    <Character look={look(p)} scale={2} />
                  </td>
                  <td>
                    <input
                      className="pick-name"
                      defaultValue={p.name}
                      disabled={p.status !== 'waiting'}
                      onBlur={(e) => e.target.value !== p.name && call('PATCH', `/api/admin/pool/picks/${p.id}`, { name: e.target.value })}
                    />
                    <div className="muted small">{p.label}</div>
                  </td>
                  <td>
                    <span className={`badge ${p.status === 'error' ? 'warn' : ''}`}>
                      {STATUS[p.status]}
                      {p.status === 'joining' && ` · ${Math.max(0, Math.round((Date.now() - p.since) / 1000))} s`}
                    </span>
                    {p.gameId && (
                      <>
                        {' '}
                        <Link to={`/game/${p.gameId}`}>{p.gameId}</Link>
                      </>
                    )}
                    {p.games > 0 && <div className="muted small">{p.games} games played</div>}
                    {p.status === 'joining' && Date.now() - p.since > 45_000 && (
                      <div className="muted small">Starting the CLI can take a minute or two (see agents.bat).</div>
                    )}
                    {p.error && <div className="error small">{p.error}</div>}
                  </td>
                  <td>
                    <label className="check small" title="After the game, wait for the next lobby again">
                      <input type="checkbox" checked={p.repeat} onChange={(e) => call('PATCH', `/api/admin/pool/picks/${p.id}`, { repeat: e.target.checked })} />{' '}
                      repeat
                    </label>
                  </td>
                  <td className="pick-actions">
                    {p.status === 'error' && (
                      <button className="small" onClick={() => call('PATCH', `/api/admin/pool/picks/${p.id}`, { retry: true })}>
                        Retry
                      </button>
                    )}
                    <button
                      className="small ghost"
                      title={
                        p.status === 'playing'
                          ? 'Removes it from the list and stops its CLI (it leaves the game)'
                          : p.status === 'joining'
                            ? 'Removes it and stops its CLI; the seat frees up'
                            : 'Remove'
                      }
                      onClick={() => call('DELETE', `/api/admin/pool/picks/${p.id}`)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
