import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { api, resetSocket, session } from './api.ts';
import { AdminPage } from './pages/AdminPage.tsx';
import { GamePage } from './pages/GamePage.tsx';
import { Home } from './pages/Home.tsx';

const StatsPage = lazy(() => import('./pages/StatsPage.tsx').then((m) => ({ default: m.StatsPage })));

export interface Account {
  id: string;
  kind: 'human' | 'ai';
  name: string;
  email: string | null;
}

export interface AppConfig {
  googleClientId: string | null;
  allowGuests: boolean;
  defaults: Record<string, unknown>;
}

interface Ctx {
  account: Account | null;
  isAdmin: boolean;
  config: AppConfig | null;
  refreshMe: () => Promise<void>;
  navigate: (to: string) => void;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { navigate } = useApp();
  return (
    <a
      href={to}
      className={className}
      onClick={(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [account, setAccount] = useState<Account | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);

  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refreshMe = useCallback(async () => {
    resetSocket();
    const me = session.token ? await api('GET', '/api/me').catch(() => null) : null;
    setAccount(me?.account ?? null);
    if (session.token && !me?.account) session.token = null;
    const admin = session.adminToken ? await api('GET', '/api/me', undefined, { admin: true }).catch(() => null) : null;
    setIsAdmin(!!admin?.admin);
    if (session.adminToken && !admin?.admin) session.adminToken = null;
  }, []);

  useEffect(() => {
    api('GET', '/api/config').then(setConfig).catch(() => {});
    refreshMe();
  }, [refreshMe]);

  const gameMatch = /^\/game\/([\w-]+)/.exec(path);
  let page: ReactNode;
  if (gameMatch) page = <GamePage key={gameMatch[1]} gameId={gameMatch[1]} />;
  else if (path.startsWith('/stats')) page = <StatsPage />;
  else if (path.startsWith('/admin')) page = <AdminPage />;
  else page = <Home />;

  return (
    <AppCtx.Provider value={{ account, isAdmin, config, refreshMe, navigate }}>
      <header className="topbar">
        <Link to="/" className="logo">
          PALERMO
        </Link>
        <nav>
          <Link to="/">Games</Link>
          <Link to="/stats">Stats</Link>
          {isAdmin && <Link to="/admin">Admin</Link>}
        </nav>
        <div className="who">
          {account ? <span>{account.name}</span> : <span className="muted">not signed in</span>}
          {isAdmin && <span className="badge admin">admin</span>}
          {(account || isAdmin) && (
            <button
              className="linkish"
              onClick={() => {
                session.token = null;
                session.adminToken = null;
                refreshMe();
              }}
            >
              sign out
            </button>
          )}
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="loading">Loading…</div>}>{page}</Suspense>
      </main>
    </AppCtx.Provider>
  );
}
