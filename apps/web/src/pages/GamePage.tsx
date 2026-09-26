import { useEffect, useMemo, useRef, useState } from 'react';
import { ROLES, type GameEvent, type PlayerView, type PublicPlayer } from '@palermo/engine';
import { api, getSocket } from '../api.ts';
import { useApp } from '../App.tsx';
import { Character, Grave, House, LOOKS, lookFor } from '../components/Sprites.tsx';

interface Report {
  player_id: string;
  model: string | null;
  summary: string;
  lessons: string;
}

const ROOFS = ['#b4533c', '#6d8a3a', '#3d6fa8', '#8a4f9e', '#c28a2c', '#4b8c8a', '#a2463f', '#5d6aa8'];

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

type BubbleKind = 'chat' | 'team' | 'thought';
type Bubble = { text: string; kind: BubbleKind; at: number };

function bubbleFrom(e: GameEvent): Bubble | null {
  if (!e.actor) return null;
  if (e.type === 'chat') return { text: String(e.data.message ?? ''), kind: 'chat', at: e.at };
  if (e.type === 'team_chat') return { text: String(e.data.message ?? ''), kind: 'team', at: e.at };
  if (e.type === 'thought') return { text: String(e.data.thought ?? ''), kind: 'thought', at: e.at };
  return null;
}

/** Rebuild what the town looked like after the first `events.length` events (for replays). */
function deriveState(events: GameEvent[]) {
  let phase = 'lobby';
  let round = 0;
  let winner: string | null = null;
  const dead = new Set<string>();
  let votes: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'phase_changed') {
      phase = String(e.data.phase);
      round = Number(e.data.round ?? round);
      votes = {};
    } else if (e.type === 'night_resolved' && e.data.victim) dead.add(String(e.data.victim));
    else if (e.type === 'day_resolved') {
      if (e.data.eliminated) dead.add(String(e.data.eliminated));
      votes = {};
    } else if (e.type === 'vote' && e.actor) {
      if (e.data.target) votes[e.actor] = String(e.data.target);
      else delete votes[e.actor];
    } else if (e.type === 'game_ended') {
      phase = 'ended';
      winner = String(e.data.winner);
    }
  }
  const last = events[events.length - 1];
  const bubble = last ? bubbleFrom(last) : null;
  return { phase, round, winner, dead, votes, bubble: bubble && last?.actor ? { [last.actor]: bubble } : {} };
}

/** How long a replay lingers on an event, at 1x speed. */
function replayDelay(e: GameEvent | undefined, admin: boolean): number {
  if (!e) return 0;
  if (e.type === 'notice' && e.vis.scope === 'admin') return 0;
  if (['player_joined', 'player_ready', 'player_left'].includes(e.type)) return 120;
  if (e.type === 'role_assigned') return admin ? 400 : 1500;
  const b = bubbleFrom(e);
  if (b) return 1200 + Math.min(5000, b.text.length * 28);
  if (e.type === 'phase_changed') return 1800;
  if (['night_resolved', 'day_resolved', 'game_ended'].includes(e.type)) return 3000;
  return 700;
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GamePage({ gameId }: { gameId: string }) {
  const { isAdmin, account } = useApp();
  const [view, setView] = useState<PlayerView | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [godView, setGodView] = useState(true);
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const [replay, setReplay] = useState<{ idx: number; playing: boolean; speed: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [adminInfo, setAdminInfo] = useState<{ usage: any[]; audit: any[] } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const admin = isAdmin && godView;

  useEffect(() => {
    const s = getSocket();
    const onSnapshot = (p: { view: PlayerView; events: GameEvent[] }) => {
      setView(p.view);
      setEvents(p.events);
    };
    const onUpdate = (p: { view: PlayerView; events: GameEvent[] }) => {
      setView(p.view);
      if (!p.events.length) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        return [...prev, ...p.events.filter((e) => !seen.has(e.seq))];
      });
      const now = Date.now();
      setBubbles((b) => {
        const next = { ...b };
        for (const e of p.events) {
          const bubble = bubbleFrom(e);
          // Thoughts only show up in god view (they are only sent to admins anyway).
          if (bubble && e.actor) next[e.actor] = { ...bubble, at: now };
        }
        return next;
      });
    };
    const onReports = (r: Report[]) => setReports(r);
    s.on('snapshot', onSnapshot);
    s.on('update', onUpdate);
    s.on('reports', onReports);
    const watch = () => s.emit('watch', { gameId, adminView: godView });
    watch();
    s.on('connect', watch);
    api('GET', `/api/games/${gameId}`, undefined, { admin: admin })
      .then((d) => {
        setReports(d.reports ?? []);
        if (d.usage) setAdminInfo({ usage: d.usage, audit: d.audit });
      })
      .catch(() => setMissing(true));
    return () => {
      s.off('snapshot', onSnapshot);
      s.off('update', onUpdate);
      s.off('reports', onReports);
      s.off('connect', watch);
      s.emit('unwatch');
    };
  }, [gameId, godView, admin]);

  // Expire speech bubbles.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setBubbles((b) => {
        const entries = Object.entries(b).filter(([, v]) => now - v.at < 6000);
        return entries.length === Object.keys(b).length ? b : Object.fromEntries(entries);
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Replay: advance one event at a time.
  useEffect(() => {
    if (!replay?.playing) return;
    if (replay.idx >= events.length) {
      setReplay((r) => r && { ...r, playing: false });
      return;
    }
    const delay = replayDelay(events[replay.idx - 1], admin) / replay.speed;
    const t = setTimeout(() => setReplay((r) => r && { ...r, idx: Math.min(events.length, r.idx + 1) }), delay);
    return () => clearTimeout(t);
  }, [replay, events, admin]);

  // Keep the log scrolled to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (el && (stick.current || replay)) el.scrollTop = el.scrollHeight;
  }, [events, replay?.idx]);

  const now = useNow(!!view?.phaseEndsAt || !!view?.chat?.cooldownUntil);
  const shownEvents = replay ? events.slice(0, replay.idx) : events;
  const replayState = useMemo(() => (replay ? deriveState(shownEvents) : null), [replay?.idx, events]);
  const phase = replayState?.phase ?? view?.phase ?? 'lobby';
  const round = replayState?.round ?? view?.round ?? 0;
  const winner = replayState ? replayState.winner : view?.winner;
  const night = phase === 'night';
  const shownBubbles = replayState?.bubble ?? bubbles;

  const voteCounts = useMemo(() => {
    const c: Record<string, number> = {};
    if (replayState) {
      const nameOf = new Map((view?.players ?? []).map((p) => [p.id, p.name]));
      for (const t of Object.values(replayState.votes)) {
        const n = t === 'skip' ? 'skip' : nameOf.get(t) ?? t;
        c[n] = (c[n] ?? 0) + 1;
      }
      return c;
    }
    for (const t of Object.values(view?.votes ?? {})) c[t] = (c[t] ?? 0) + 1;
    return c;
  }, [view?.votes, view?.players, replayState]);

  if (missing && !view) return <div className="card">Game not found.</div>;
  if (!view) return <div className="loading">Loading town…</div>;

  const me = view.you;
  const req = view.required;
  const act = async (path: string, body: unknown) => {
    try {
      setError(null);
      await api('POST', `/api/games/${gameId}/${path}`, body);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const adminAct = async (path: string, body: unknown = {}) => {
    try {
      setError(null);
      await api('POST', `/api/games/${gameId}/${path}`, body, { admin: true });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const options = req.options ?? [];
  const canTarget = (p: PublicPlayer) => !!me && options.includes(p.name);
  const title = phase === 'lobby' ? 'Lobby' : phase === 'ended' ? 'Game over' : `${night ? 'Night' : 'Day'} ${round}`;
  const timeLeft = !replay && view.phaseEndsAt ? fmtTime(view.phaseEndsAt - now) : null;
  const isAlive = (p: PublicPlayer) => (replayState ? !replayState.dead.has(p.id) : p.alive);
  const startedAt = events.find((e) => e.type === 'game_started')?.at ?? events[0]?.at ?? 0;
  const replayClock = replay && shownEvents.length ? fmtTime((shownEvents[shownEvents.length - 1].at ?? startedAt) - startedAt) : null;
  const canChat = !replay && (view.phase === 'lobby' || (me?.alive && (view.phase === 'day' || (view.phase === 'night' && me.role === 'murderer'))));
  const joined = !!me;

  return (
    <div className={`game ${phase}`}>
      <section className={`scene ${night ? 'is-night' : 'is-day'} ${phase === 'ended' ? 'is-ended' : ''}`}>
        <div className="sky">
          {night ? <div className="moon" /> : <div className="sun" />}
          {night && <div className="stars" />}
        </div>
        <div className="banner">
          <span className="phase-title">{title}</span>
          {timeLeft && <span className="timer">{timeLeft}</span>}
          {phase === 'day' && !replay && (
            <span className="votes-progress">
              votes {view.votedCount}/{view.aliveCount}
            </span>
          )}
          {replayClock && <span className="timer">replay +{replayClock}</span>}
          {winner && (
            <span className={`winner ${winner}`}>
              {winner === 'mafia' ? 'Murderers win' : winner === 'town' ? 'Town wins' : 'Draw'}
            </span>
          )}
          {isAdmin && (
            <label className="god-toggle">
              <input type="checkbox" checked={godView} onChange={(e) => setGodView(e.target.checked)} /> god view
            </label>
          )}
        </div>
        <div className="town-row">
          {view.players.map((p, i) => {
            const look = lookFor(p);
            const bubble = shownBubbles[p.id];
            const alive = isAlive(p);
            const votes = voteCounts[p.name] ?? 0;
            const target = canTarget(p) && !!me?.alive;
            return (
              <button
                key={p.id}
                className={`seat ${alive ? '' : 'dead'} ${p.id === me?.id ? 'me' : ''} ${selected === p.name ? 'selected' : ''} ${target ? 'targetable' : ''}`}
                onClick={() => target && setSelected(p.name)}
                disabled={!target}
                title={p.realName ? `${p.realName}` : undefined}
              >
                {bubble && (
                  <span className={`bubble ${bubble.kind}`}>
                    {bubble.kind === 'thought' && '💭 '}
                    {bubble.text.length > 110 ? `${bubble.text.slice(0, 110)}…` : bubble.text}
                  </span>
                )}
                {votes > 0 && <span className="vote-badge">{votes}</span>}
                <House night={night} roof={ROOFS[i % ROOFS.length]} scale={4} />
                <span className="figure">{alive ? <Character look={look} scale={4} className={bubble ? 'talk' : 'bob'} style={{ animationDelay: `${(i % 5) * 0.2}s` }} /> : <Grave scale={4} />}</span>
                <span className="nametag" style={{ borderColor: LOOKS[look].color }}>
                  {p.name}
                </span>
                <span className="modeltag">
                  {p.kind === 'human' ? 'human' : p.model ?? (p.kind ? LOOKS[look].label : '???')}
                  {p.verified === false && p.kind === 'ai' ? ' (self-reported)' : ''}
                </span>
                {p.role && <span className={`roletag ${p.role}`}>{ROLES[p.role].name}</span>}
                {phase === 'lobby' && <span className={`readytag ${p.ready ? 'on' : ''}`}>{p.ready ? 'ready' : 'not ready'}</span>}
              </button>
            );
          })}
          {!view.players.length && <p className="empty-town">The town is empty. Waiting for players…</p>}
        </div>
      </section>

      <div className="game-body">
        <section className="card log-card">
          <div
            className="log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {shownEvents.map((e) => (
              <EventLine key={e.seq} e={e} players={view.players} admin={view.isAdmin} />
            ))}
          </div>
          {view.phase === 'ended' && events.length > 0 && (
            <div className="replay-bar">
              {!replay ? (
                <button className="primary" onClick={() => setReplay({ idx: 0, playing: true, speed: 1 })}>
                  ▶ Replay game
                </button>
              ) : (
                <>
                  <button onClick={() => setReplay((r) => r && { ...r, idx: Math.max(0, r.idx - 1), playing: false })} title="Step back">
                    ◀
                  </button>
                  <button className="primary" onClick={() => setReplay((r) => r && { ...r, playing: !r.playing, idx: r.idx >= events.length ? 0 : r.idx })}>
                    {replay.playing ? '❚❚ Pause' : '▶ Play'}
                  </button>
                  <button onClick={() => setReplay((r) => r && { ...r, idx: Math.min(events.length, r.idx + 1), playing: false })} title="Step forward">
                    ▶
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={events.length}
                    value={replay.idx}
                    onChange={(e) => setReplay((r) => r && { ...r, idx: Number(e.target.value), playing: false })}
                    aria-label="Replay position"
                  />
                  <select value={replay.speed} onChange={(e) => setReplay((r) => r && { ...r, speed: Number(e.target.value) })} aria-label="Replay speed">
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                  <button className="ghost" onClick={() => setReplay(null)}>
                    Exit
                  </button>
                </>
              )}
            </div>
          )}
          {joined && canChat && (
            <form
              className="chat-input"
              onSubmit={(ev) => {
                ev.preventDefault();
                const input = ev.currentTarget.elements.namedItem('msg') as HTMLInputElement;
                if (!input.value.trim()) return;
                act('say', { message: input.value });
                input.value = '';
              }}
            >
              <input
                name="msg"
                placeholder={night ? 'Whisper to your fellow murderers…' : 'Say something to the town…'}
                autoComplete="off"
                maxLength={view.chat.maxLength ?? 2000}
              />
              {view.phase !== 'lobby' && (view.chat.left !== null || (view.chat.cooldownUntil ?? 0) > now) && (
                <span className="chat-quota">
                  {view.chat.left !== null ? `${view.chat.left} left` : ''}
                  {(view.chat.cooldownUntil ?? 0) > now ? ` · wait ${Math.ceil(((view.chat.cooldownUntil ?? 0) - now) / 1000)}s` : ''}
                </span>
              )}
              <button type="submit" disabled={view.phase !== 'lobby' && (view.chat.left === 0 || (view.chat.cooldownUntil ?? 0) > now)}>
                Send
              </button>
            </form>
          )}
        </section>

        <aside className="side">
          {me && (
            <section className={`card you ${me.team ?? ''}`}>
              <h3>{me.name}</h3>
              {me.role ? (
                <>
                  <p className={`role-name ${me.role}`}>{ROLES[me.role].name}</p>
                  <p className="small">{me.roleDescription}</p>
                  {me.teammates.length > 0 && <p className="small">Fellow murderers: {me.teammates.join(', ')}</p>}
                </>
              ) : (
                <p className="small muted">Your role will be revealed when the game starts.</p>
              )}
              {!me.alive && <p className="dead-note">You are dead. You can still watch.</p>}
            </section>
          )}

          {me && view.phase === 'lobby' && (
            <section className="card">
              <button className="primary" onClick={() => act('ready', { ready: !view.players.find((p) => p.id === me.id)?.ready })}>
                {view.players.find((p) => p.id === me.id)?.ready ? 'Not ready' : "I'm ready"}
              </button>
              <button className="ghost" onClick={() => act('leave', {})}>
                Leave
              </button>
            </section>
          )}

          {!me && view.phase === 'lobby' && account && (
            <section className="card">
              <button className="primary" onClick={() => act('join', {})}>
                Join this game
              </button>
            </section>
          )}

          {me && me.alive && (req.kind === 'vote' || req.kind === 'night_action') && (
            <section className="card action">
              <h3>{req.kind === 'vote' ? 'Vote' : req.actionKind === 'kill' ? 'Choose a victim' : req.actionKind === 'protect' ? 'Protect someone' : 'Follow someone'}</h3>
              <p className="small">{req.hint}</p>
              <div className="option-grid">
                {options.map((o) => (
                  <button key={o} className={selected === o ? 'selected' : ''} onClick={() => setSelected(o)}>
                    {o}
                  </button>
                ))}
              </div>
              <div className="row">
                <button
                  className="primary"
                  disabled={!selected || !options.includes(selected)}
                  onClick={() => {
                    if (!selected) return;
                    act(req.kind === 'vote' ? 'vote' : 'night', { target: selected });
                    setSelected(null);
                  }}
                >
                  {req.kind === 'vote' ? `Vote ${selected ?? ''}` : `Confirm ${selected ?? ''}`}
                </button>
                {req.kind === 'vote' && req.done && (
                  <button className="ghost" onClick={() => act('vote', { target: null })}>
                    Withdraw
                  </button>
                )}
              </div>
            </section>
          )}

          {error && <p className="error">{error}</p>}

          {isAdmin && (
            <section className="card admin-controls">
              <h3>Game master</h3>
              <div className="row wrap">
                {view.phase === 'lobby' && (
                  <>
                    <button onClick={() => adminAct('start', { force: false })}>Start</button>
                    <button onClick={() => adminAct('start', { force: true })}>Force start</button>
                    <button onClick={() => adminAct('bots', { count: 1 })}>+ Bot</button>
                  </>
                )}
                {(view.phase === 'night' || view.phase === 'day') && <button onClick={() => adminAct('advance')}>End {view.phase} now</button>}
                {view.phase !== 'ended' && (
                  <button className="danger" onClick={() => confirm('Stop this game?') && adminAct('abort')}>
                    Stop game
                  </button>
                )}
              </div>
              <p className="small muted">
                Game id <code>{gameId}</code> · mode {view.settings.mode} · {view.settings.identityVisibility} · notes {view.settings.notesMode}
                {view.settings.freedomMode ? ' · NO RULES' : ''}
              </p>
              {adminInfo && adminInfo.usage.length > 0 && <UsageTable usage={adminInfo.usage} />}
              {adminInfo && adminInfo.audit.length > 0 && (
                <details>
                  <summary>Audit log ({adminInfo.audit.length})</summary>
                  <ul className="small">
                    {adminInfo.audit.map((a) => (
                      <li key={a.id}>
                        {a.kind}: {a.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
        </aside>
      </div>

      {reports.length > 0 && (
        <section className="card reports">
          <h2>Player reports</h2>
          <div className="report-grid">
            {reports.map((r) => {
              const p = view.players.find((x) => x.id === r.player_id);
              return (
                <article key={r.player_id} className="report">
                  <header>
                    {p && <Character look={lookFor(p)} scale={2} />}
                    <b>{p?.name ?? r.player_id}</b>
                    <span className="muted">{r.model}</span>
                    {p?.role && <span className={`roletag ${p.role}`}>{ROLES[p.role].name}</span>}
                  </header>
                  <p>{r.summary}</p>
                  <p className="lessons">
                    <b>Lessons:</b> {r.lessons}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function EventLine({ e, players, admin }: { e: GameEvent; players: PublicPlayer[]; admin: boolean }) {
  const actor = e.actor ? players.find((p) => p.id === e.actor) : undefined;
  const color = actor ? LOOKS[lookFor(actor)].color : undefined;
  switch (e.type) {
    case 'chat':
      return (
        <div className="ev chat">
          <b style={{ color }}>{actor?.name ?? '?'}</b> {String(e.data.message ?? '')}
        </div>
      );
    case 'team_chat':
      return (
        <div className="ev team">
          <span className="pill">murderers</span> <b style={{ color }}>{actor?.name}</b> {String(e.data.message ?? '')}
        </div>
      );
    case 'thought':
      return (
        <div className="ev thought">
          <span className="pill">thinks</span> <b style={{ color }}>{actor?.name}</b> <i>{String(e.data.thought ?? '')}</i>
        </div>
      );
    case 'phase_changed':
      return <div className={`ev divider ${e.data.phase}`}>{e.text}</div>;
    case 'night_resolved':
    case 'day_resolved':
    case 'game_started':
    case 'game_ended':
      return <div className={`ev headline ${e.type}`}>{e.text}</div>;
    case 'role_assigned':
      if (admin && actor) {
        const role = e.data.role as keyof typeof ROLES;
        return (
          <div className="ev private">
            <span className="pill">role</span> {actor.name} is {ROLES[role]?.name ?? role}
          </div>
        );
      }
      return (
        <div className="ev private">
          <span className="pill">private</span> {e.text}
        </div>
      );
    case 'tracker_result':
    case 'doctor_result':
      return (
        <div className="ev private">
          <span className="pill">{admin && actor ? `to ${actor.name}` : 'private'}</span> {e.text}
        </div>
      );
    case 'night_action':
      return <div className="ev secret">{e.text}</div>;
    case 'vote':
      return <div className="ev vote">{e.text}</div>;
    case 'notice':
      if (e.vis.scope === 'admin') return null;
      return <div className="ev notice">{e.text}</div>;
    default:
      return <div className="ev notice">{e.text}</div>;
  }
}

function UsageTable({ usage }: { usage: any[] }) {
  const byModel = new Map<string, { in: number; out: number; cost: number }>();
  for (const u of usage) {
    const k = u.model ?? '?';
    const x = byModel.get(k) ?? { in: 0, out: 0, cost: 0 };
    x.in += u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
    x.out += u.output_tokens;
    x.cost += u.cost_usd ?? 0;
    byModel.set(k, x);
  }
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>model</th>
          <th>tokens in</th>
          <th>out</th>
          <th>API-equiv $</th>
        </tr>
      </thead>
      <tbody>
        {[...byModel.entries()].map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v.in.toLocaleString()}</td>
            <td>{v.out.toLocaleString()}</td>
            <td>{v.cost ? v.cost.toFixed(2) : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
