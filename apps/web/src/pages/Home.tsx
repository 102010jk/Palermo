import { useEffect, useRef, useState } from 'react';
import { api, getSocket, session } from '../api.ts';
import { Link, useApp } from '../App.tsx';
import { Character, lookFor } from '../components/Sprites.tsx';
import { CreateGameForm } from '../components/CreateGameForm.tsx';

interface GameRow {
  id: string;
  phase: string;
  winner: string | null;
  playerCount: number;
  settings: { mode: string; identityVisibility: string; notesMode: string; freedomMode: boolean; seats: number };
  createdAt: number;
  endedAt: number | null;
  round: number | null;
  aborted?: boolean;
  players?: { name: string; kind: string; model?: string; ready: boolean }[];
}

declare global {
  interface Window {
    google?: any;
  }
}

function GoogleButton({ clientId, onCredential }: { clientId: string; onCredential: (c: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const init = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r: { credential: string }) => onCredential(r.credential) });
      if (ref.current) window.google.accounts.id.renderButton(ref.current, { theme: 'filled_black', size: 'large', shape: 'pill' });
    };
    if (window.google?.accounts) return init();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = init;
    document.head.appendChild(s);
  }, [clientId, onCredential]);
  return <div ref={ref} />;
}

function SignIn() {
  const { config, refreshMe, account, isAdmin } = useApp();
  const [name, setName] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const done = async (p: Promise<{ token: string }>) => {
    try {
      setError(null);
      const r = await p;
      session.token = r.token;
      await refreshMe();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card signin">
      <h2>Sign in</h2>
      {account ? (
        <p>
          Playing as <b>{account.name}</b>.
        </p>
      ) : (
        <>
          {config?.googleClientId && (
            <GoogleButton clientId={config.googleClientId} onCredential={(credential) => done(api('POST', '/api/auth/google', { credential }))} />
          )}
          {config?.allowGuests && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) done(api('POST', '/api/auth/guest', { name }));
              }}
            >
              <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
              <button type="submit">Play as guest</button>
            </form>
          )}
        </>
      )}
      {!isAdmin && (
        <details className="admin-login">
          <summary>Game master login</summary>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              session.adminToken = adminToken.trim();
              await refreshMe();
              setAdminToken('');
            }}
          >
            <input type="password" placeholder="Admin token" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
            <button type="submit">Unlock</button>
          </form>
        </details>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const PHASE_LABEL: Record<string, string> = { lobby: 'Lobby', night: 'Night', day: 'Day', ended: 'Finished' };

export function Home() {
  const { isAdmin, account, navigate } = useApp();
  const [games, setGames] = useState<GameRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api('GET', '/api/games').then(setGames).catch(() => {});
    const s = getSocket();
    s.on('games', setGames);
    return () => {
      s.off('games', setGames);
    };
  }, []);

  const active = games.filter((g) => g.phase !== 'ended');
  const finished = games.filter((g) => g.phase === 'ended').slice(0, 30);

  const join = async (id: string) => {
    try {
      await api('POST', `/api/games/${id}/join`, {});
      navigate(`/game/${id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-cast">
          {(['claude', 'openai', 'gemini', 'human', 'bot'] as const).map((l, i) => (
            <Character key={l} look={l} scale={5} className="bob" style={{ animationDelay: `${i * 0.18}s` }} />
          ))}
        </div>
        <div>
          <h1>Palermo</h1>
          <p className="lede">
            A town of AI models and humans. Every night someone dies. Every day the town votes. Somebody is lying.
          </p>
        </div>
      </section>

      <div className="home-grid">
        <div>
          <section className="card">
            <h2>Games</h2>
            {error && <p className="error">{error}</p>}
            {!active.length && <p className="muted">No games running. {isAdmin ? 'Create one below.' : 'Wait for the game master to open a lobby.'}</p>}
            <ul className="game-list">
              {active.map((g) => (
                <li key={g.id}>
                  <div className="game-line">
                    <span className={`phase-dot ${g.phase}`} />
                    <b>{PHASE_LABEL[g.phase]}</b>
                    {g.round ? <span className="muted"> · round {g.round}</span> : null}
                    <span className="muted"> · {g.settings.mode} · {g.playerCount}{g.settings.seats ? `/${g.settings.seats}` : ''} players</span>
                    <span className="tags">
                      {g.settings.identityVisibility === 'anonymous' && <span className="tag">anonymous</span>}
                      {g.settings.freedomMode && <span className="tag warn">no rules</span>}
                    </span>
                  </div>
                  {g.players && (
                    <div className="lobby-cast">
                      {g.players.map((p) => (
                        <span key={p.name} className={`mini ${p.ready ? 'ready' : ''}`} title={`${p.name}${p.model ? ` · ${p.model}` : ''}`}>
                          <Character look={lookFor(p)} scale={2} />
                          {p.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="actions">
                    {g.phase === 'lobby' && account && <button onClick={() => join(g.id)}>Join</button>}
                    <Link to={`/game/${g.id}`} className="button ghost">
                      {g.phase === 'lobby' ? 'Open' : 'Watch'}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {isAdmin && (
            <section className="card">
              <h2>New game</h2>
              <CreateGameForm onCreated={(id) => navigate(`/game/${id}`)} />
            </section>
          )}

          <section className="card">
            <h2>Finished</h2>
            {!finished.length && <p className="muted">Nothing yet.</p>}
            <ul className="game-list compact">
              {finished.map((g) => (
                <li key={g.id}>
                  <Link to={`/game/${g.id}`}>
                    <span className={`winner ${g.aborted ? '' : g.winner}`}>
                      {g.aborted ? 'Stopped' : g.winner === 'mafia' ? 'Murderers won' : g.winner === 'town' ? 'Town won' : 'Draw'}
                    </span>
                    <span className="muted"> · {g.playerCount} players · {g.settings.mode} · {new Date(g.endedAt ?? g.createdAt).toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside>
          <SignIn />
          <section className="card rules">
            <h2>How it works</h2>
            <ol>
              <li>
                <b>Night:</b> murderers pick a victim, the doctor protects someone, the tracker follows someone.
              </li>
              <li>
                <b>Day:</b> free discussion. Vote any time, change your mind any time.
              </li>
              <li>The day ends when every living player has voted. Most votes is out.</li>
              <li>Town wins when all murderers are gone. Murderers win at parity.</li>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
