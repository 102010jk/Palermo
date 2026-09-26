import { useEffect, useMemo, useRef, useState } from 'react';
import { ROLES, type GameEvent, type NightVisit, type PlayerView, type PublicPlayer } from '@palermo/engine';
import { api, download, getSocket } from '../api.ts';
import { useApp } from '../App.tsx';
import { Character, Grave, House, LOOKS, lookFor } from '../components/Sprites.tsx';
import { Stage, useStage, type StageLine } from '../components/Stage.tsx';
import { TownRing, type Bubble, type NightStep } from '../components/TownRing.tsx';

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

/** God-view night animation: order of the walks and their timing (matches the server's VISUAL_VISIT_MS). */
const WALK_ORDER: Record<string, number> = { trap: 0, protect: 1, track: 2, kill: 3 };
const STEP_MS = { go: 1900, act: 1200, back: 1900 };

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
    } else if (e.type === 'night_resolved') {
      for (const v of (e.data.victims as string[] | undefined) ?? (e.data.victim ? [String(e.data.victim)] : [])) dead.add(v);
    } else if (e.type === 'shot' && e.data.target) {
      dead.add(String(e.data.target));
      for (const [voter, t] of Object.entries(votes)) if (t === e.data.target || voter === e.data.target) delete votes[voter];
    } else if (e.type === 'day_resolved') {
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
  if (e.type === 'notice' && e.data.kind === 'night_plan') {
    return admin ? 1000 + ((e.data.visits as NightVisit[]) ?? []).filter((v) => !v.home).length * 5000 : 0;
  }
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
  const { isAdmin, account, navigate } = useApp();
  const [view, setView] = useState<PlayerView | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [godView, setGodView] = useState(true);
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const stage = useStage();
  const [replay, setReplay] = useState<{ idx: number; playing: boolean; speed: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [adminInfo, setAdminInfo] = useState<{ usage: any[]; audit: any[] } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const admin = isAdmin && godView;
  const [layout, setLayout] = useState<'ring' | 'row' | null>(null);
  const [step, setStep] = useState<NightStep | null>(null);
  const [traps, setTraps] = useState<Set<string>>(new Set());
  const planSeq = useRef(0);
  const stepTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => stepTimers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const s = getSocket();
    const onSnapshot = (p: { view: PlayerView; events: GameEvent[] }) => {
      setView(p.view);
      setEvents(p.events);
      // History is in the log; the stage only plays what is said from now on.
      stage.reset(p.events[p.events.length - 1]?.seq ?? 0);
    };
    const onUpdate = (p: { view: PlayerView; events: GameEvent[] }) => {
      setView(p.view);
      if (!p.events.length) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        return [...prev, ...p.events.filter((e) => !seen.has(e.seq))];
      });
      stage.push(p.events);
      const now = Date.now();
      setBubbles((b) => {
        const next = { ...b };
        const forgedBy = new Map(p.events.filter((e) => e.data.kind === 'forged').map((e) => [Number(e.data.chatSeq), String(e.data.by)]));
        for (const e of p.events) {
          const bubble = bubbleFrom(e);
          // Thoughts only show up in god view (they are only sent to admins anyway).
          if (bubble && e.actor) next[e.actor] = { ...bubble, at: now, forgedBy: forgedBy.get(e.seq) };
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
  // Replays: the stage shows the latest line said so far.
  const replayLine = useMemo(() => {
    if (!replay) return null;
    const e = [...shownEvents].reverse().find((x) => ['chat', 'team_chat', 'last_words', 'testament'].includes(x.type) && x.actor && x.phase !== 'lobby');
    if (!e) return null;
    const line: StageLine & { start: number } = {
      seq: e.seq,
      actor: e.actor!,
      text: String(e.data.message ?? ''),
      kind: e.type === 'chat' ? 'chat' : e.type === 'team_chat' ? 'team' : e.type === 'last_words' ? 'last' : 'testament',
      ms: 1,
      start: 0,
    };
    return line;
  }, [replay, shownEvents]);
  // Town view: only the current speaker has a speech bubble (the whole text is on the stage below), thoughts are markers.
  const ringBubbles = useMemo(() => {
    if (replayState) return shownBubbles;
    const out: Record<string, Bubble> = {};
    for (const [id, b] of Object.entries(bubbles)) if (b.kind === 'thought') out[id] = b;
    const c = stage.current;
    if (c && stage.speaking) out[c.actor] = { text: c.text, kind: c.kind === 'team' ? 'team' : 'chat', at: c.start, forgedBy: c.forgedBy };
    return out;
  }, [replayState, shownBubbles, bubbles, stage.current, stage.speaking]);

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

  const ring = (layout ?? (view?.settings.gameStyle === 'visual' ? 'ring' : 'row')) === 'ring';

  // God view: play the night's visits one after another (live, and in replays).
  useEffect(() => {
    if (!ring || !admin) return;
    const source = replay ? shownEvents : events;
    let plan: GameEvent | undefined;
    for (let i = source.length - 1; i >= 0; i--) {
      if (source[i].data?.kind === 'night_plan') {
        plan = source[i];
        break;
      }
    }
    if (!plan || plan.seq <= planSeq.current) return;
    planSeq.current = plan.seq;
    if (replay ? source[source.length - 1]?.seq !== plan.seq : view?.phase !== 'night') return;
    stepTimers.current.forEach(clearTimeout);
    stepTimers.current = [];
    const visits = (plan.data.visits as NightVisit[]) ?? [];
    setTraps(new Set(visits.filter((v) => v.kind === 'trap' && !v.crazy).map((v) => v.to)));
    const walks = visits.filter((v) => !v.home).sort((a, b) => (WALK_ORDER[a.kind] ?? 9) - (WALK_ORDER[b.kind] ?? 9));
    const speed = replay?.speed ?? 1;
    let t = 600 / speed;
    for (const v of walks) {
      for (const stage of ['go', 'act', 'back'] as const) {
        const s = { actor: v.from, to: v.to, kind: v.kind, stage, caught: v.caught };
        stepTimers.current.push(setTimeout(() => setStep(s), t));
        t += STEP_MS[stage] / speed;
      }
    }
    stepTimers.current.push(setTimeout(() => setStep(null), t));
  }, [ring, admin, events, shownEvents.length, replay?.speed, view?.phase]);

  useEffect(() => {
    if (phase !== 'night') setTraps(new Set());
  }, [phase]);

  const lastShot = [...shownEvents].reverse().find((e) => e.type === 'shot');
  const shotId = lastShot && (replay || Date.now() - lastShot.at < 4000) ? String(lastShot.data.target) : null;

  if (missing && !view) return <div className="card">Game not found.</div>;
  if (!view) return <div className="loading">Loading town…</div>;

  const me = view.you;
  const req = view.required;
  // Ventriloquist lines: chat seq -> real author (admin notices, god view only).
  const forged = new Map<number, string>();
  for (const e of events) if (e.data.kind === 'forged') forged.set(Number(e.data.chatSeq), String(e.data.by));
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
  const canChat = !replay && (view.phase === 'lobby' || (me?.alive && (view.phase === 'day' || (view.phase === 'night' && me.role === 'murderer' && (me.teammates?.length ?? 0) > 0))));
  const joined = !!me;
  const idByName = new Map(view.players.map((p) => [p.name, p.id]));
  const ringVotes: Record<string, string> = replayState
    ? replayState.votes
    : Object.fromEntries(
        Object.entries(view.votes)
          .map(([v, t]) => [idByName.get(v) ?? '', t === 'skip' ? 'skip' : idByName.get(t) ?? ''])
          .filter(([v, t]) => v && t),
      );

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
          {view.paused && !replay && <span className="timer paused">paused: {view.paused.reason}</span>}
          {winner && (
            <span className={`winner ${winner}`}>
              {winner === 'mafia' ? 'Murderers win' : winner === 'town' ? 'Town wins' : 'Draw'}
            </span>
          )}
          <button className="small ghost layout-toggle" onClick={() => setLayout(ring ? 'row' : 'ring')} title="Switch the town view">
            {ring ? 'row view' : 'town view'}
          </button>
          {isAdmin && (
            <label className="god-toggle">
              <input type="checkbox" checked={godView} onChange={(e) => setGodView(e.target.checked)} /> god view
            </label>
          )}
        </div>
        {ring ? (
          <TownRing
            players={view.players}
            phase={phase}
            night={night}
            isAlive={isAlive}
            meId={me?.id}
            bubbles={ringBubbles}
            votes={ringVotes}
            selected={selected}
            canTarget={(p) => canTarget(p) && !!me?.alive}
            onSelect={setSelected}
            godView={admin}
            step={step}
            traps={admin ? traps : new Set()}
            shotId={shotId}
          />
        ) : (
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
        )}
        {ring && phase !== 'lobby' && (
          <Stage
            line={replay ? replayLine : stage.current}
            speaking={!replay && stage.speaking}
            still={!!replay}
            queued={replay ? [] : stage.queued}
            waiting={replay ? [] : view.speechQueue ?? []}
            players={view.players}
            godView={admin}
          />
        )}
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
              <EventLine key={e.seq} e={e} players={view.players} admin={view.isAdmin} forgedBy={admin ? forged.get(e.seq) : undefined} />
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
                  {me.teammates.length > 0 && <p className="small">Mafia partners: {me.teammates.join(', ')}</p>}
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
                {req.dayAction?.kind === 'shoot' && (
                  <button
                    className="danger"
                    disabled={!selected || !req.dayAction.options.includes(selected)}
                    title="Your single bullet: kills at once and reveals you as the Gunman"
                    onClick={() => {
                      if (!selected || !confirm(`Shoot ${selected}? You have only one bullet and everyone will know you are the Gunman.`)) return;
                      act('shoot', { target: selected });
                      setSelected(null);
                    }}
                  >
                    Shoot {selected ?? ''}
                  </button>
                )}
              </div>
            </section>
          )}

          {me && me.alive && req.kind === 'mail' && (
            <MailCard options={req.options ?? []} testament={!!req.mail?.testamentAvailable} chosen={req.mail?.chosen ?? null} onSend={(body) => act('mail_bird', body)} />
          )}

          {me && me.alive && !!req.links?.length && (
            <LinkCard links={req.links} onSend={(to, message) => act('bird_message', { to, message })} />
          )}

          {me && !me.alive && req.kind === 'last_words' && <LastWordsCard onSend={(message) => act('last_words', { message })} />}

          {me && me.alive && req.dayAction?.kind === 'throw_voice' && (
            <VoiceCard options={req.dayAction.options} onSend={(as, message) => act('throw_voice', { as, message })} />
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
                <button onClick={() => download(`/api/admin/games/${gameId}/export`, `palermo-${gameId}.json`).catch((e) => setError(e.message))}>
                  Download JSON
                </button>
                {view.phase === 'ended' && (
                  <button
                    className="danger"
                    title="Removes the game, its reports, token usage and the playbook versions saved during it"
                    onClick={async () => {
                      if (!confirm('Delete this game from the records? Its reports, token usage and the playbook versions saved in it go too.')) return;
                      try {
                        await api('DELETE', `/api/games/${gameId}`, undefined, { admin: true });
                        navigate('/');
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Delete game
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

/** Mail Bird's night: letters, a link between two players, the sealed letter, or nothing. */
function MailCard({ options, testament, chosen, onSend }: { options: string[]; testament: boolean; chosen: string | null; onSend: (body: unknown) => void }) {
  const [mode, setMode] = useState<'letters' | 'connect' | 'testament' | 'none'>('letters');
  const [letters, setLetters] = useState([
    { to: options[0] ?? '', message: '' },
    { to: options[1] ?? options[0] ?? '', message: '' },
  ]);
  const [a, setA] = useState(options[0] ?? '');
  const [b, setB] = useState(options[1] ?? '');
  const [message, setMessage] = useState('');
  const pickPlayer = (value: string, set: (v: string) => void) => (
    <select value={value} onChange={(e) => set(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
  const filled = letters.filter((l) => l.message.trim());
  const send = () => {
    if (mode === 'letters') onSend({ mode, letters: filled.map((l) => ({ to: l.to, message: l.message.trim() })) });
    else if (mode === 'connect') onSend({ mode, a, b });
    else if (mode === 'testament') onSend({ mode, message: message.trim() });
    else onSend({ mode });
  };
  const ready = mode === 'letters' ? filled.length > 0 : mode === 'connect' ? !!a && !!b && a !== b : mode === 'testament' ? !!message.trim() : true;
  return (
    <section className="card action mail-card">
      <h3>🕊 Mail bird</h3>
      <p className="small">One choice per night.{chosen ? ` Chosen tonight: ${chosen} (you can change it).` : ''}</p>
      <div className="row wrap mail-modes">
        {(['letters', 'connect', ...(testament ? ['testament'] : []), 'none'] as const).map((m) => (
          <button key={m} className={mode === m ? 'selected' : ''} onClick={() => setMode(m as typeof mode)}>
            {{ letters: 'Letters (up to 2)', connect: 'Link two players', testament: 'Sealed letter', none: 'Nothing' }[m]}
          </button>
        ))}
      </div>
      {mode === 'letters' &&
        letters.map((l, i) => (
          <div key={i} className="row wrap">
            {pickPlayer(l.to, (v) => setLetters((xs) => xs.map((x, j) => (j === i ? { ...x, to: v } : x))))}
            <input
              placeholder={i === 0 ? 'Letter (anonymous, arrives at dawn)' : 'Second letter (optional)'}
              value={l.message}
              onChange={(e) => setLetters((xs) => xs.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))}
            />
          </div>
        ))}
      {mode === 'connect' && (
        <div className="row wrap">
          {pickPlayer(a, setA)} <span>↔</span> {pickPlayer(b, setB)}
          <span className="small muted">Tomorrow each may send the other one private message.</span>
        </div>
      )}
      {mode === 'testament' && (
        <textarea placeholder="Read out to everyone when you die (once per game)" value={message} onChange={(e) => setMessage(e.target.value)} />
      )}
      <button className="primary" disabled={!ready} onClick={send}>
        Send the bird
      </button>
    </section>
  );
}

/** A mail bird linked this player with others today: one private message to each. */
function LinkCard({ links, onSend }: { links: string[]; onSend: (to: string, message: string) => void }) {
  const [to, setTo] = useState(links[0]);
  const [message, setMessage] = useState('');
  const target = links.includes(to) ? to : links[0];
  return (
    <section className="card action mail-card">
      <h3>🕊 Private message</h3>
      <p className="small">A mail bird linked you with {links.join(', ')}. One private message each; only the two of you read it.</p>
      <div className="row wrap">
        <select value={target} onChange={(e) => setTo(e.target.value)}>
          {links.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input placeholder="Your one private message" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button
          className="primary"
          disabled={!message.trim()}
          onClick={() => {
            onSend(target, message.trim());
            setMessage('');
          }}
        >
          Send to {target}
        </button>
      </div>
    </section>
  );
}

function LastWordsCard({ onSend }: { onSend: (message: string) => void }) {
  const [message, setMessage] = useState('');
  return (
    <section className="card action">
      <h3>🪦 Last words</h3>
      <p className="small">You died. Leave one public message for the town (optional).</p>
      <div className="row wrap">
        <input placeholder="Your last words" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className="primary" disabled={!message.trim()} onClick={() => onSend(message.trim())}>
          Say it
        </button>
      </div>
    </section>
  );
}

/** Ventriloquist's once-a-day action: a public message in another player's name. */
function VoiceCard({ options, onSend }: { options: string[]; onSend: (as: string, message: string) => void }) {
  const [as, setAs] = useState(options[0] ?? '');
  const [message, setMessage] = useState('');
  return (
    <section className="card action voice-card">
      <h3>🗣 Throw your voice</h3>
      <p className="small">Once today: the town hears this as if the chosen player said it. They will see it too.</p>
      <div className="row wrap">
        <select value={as} onChange={(e) => setAs(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input placeholder="What they will seem to say…" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button
          className="danger"
          disabled={!as || !message.trim()}
          onClick={() => {
            onSend(as, message.trim());
            setMessage('');
          }}
        >
          Speak as {as}
        </button>
      </div>
    </section>
  );
}

function EventLine({ e, players, admin, forgedBy }: { e: GameEvent; players: PublicPlayer[]; admin: boolean; forgedBy?: string }) {
  const actor = e.actor ? players.find((p) => p.id === e.actor) : undefined;
  const color = actor ? LOOKS[lookFor(actor)].color : undefined;
  switch (e.type) {
    case 'chat': {
      const real = forgedBy ? players.find((p) => p.id === forgedBy) : undefined;
      return (
        <div className={`ev chat ${forgedBy ? 'forged' : ''}`}>
          <b style={{ color }}>{actor?.name ?? '?'}</b> {String(e.data.message ?? '')}
          {forgedBy && <span className="pill forged-pill" title="Ventriloquist: this line was not written by the player it shows">🗣 forged by {real?.name ?? '?'}</span>}
        </div>
      );
    }
    case 'team_chat':
      return (
        <div className="ev team">
          <span className="pill">mafia</span> <b style={{ color }}>{actor?.name}</b> {String(e.data.message ?? '')}
        </div>
      );
    case 'letter': {
      // God view: say who received it (players see only their own mail).
      const toId = e.data.to ? String(e.data.to) : e.vis.scope === 'players' ? e.vis.ids[0] : undefined;
      const to = toId ? players.find((p) => p.id === toId) : undefined;
      const label = !admin ? 'mail bird' : e.data.link && e.actor ? 'private link' : to ? `to ${to.name}` : 'mail bird';
      return (
        <div className="ev private letter">
          <span className="pill">🕊 {label}</span> {e.text}
        </div>
      );
    }
    case 'testament':
      return (
        <div className="ev headline testament">
          <span className="pill">sealed letter</span> {e.text}
        </div>
      );
    case 'last_words':
      return (
        <div className="ev chat last-words">
          <span className="pill">last words</span> <b style={{ color }}>{actor?.name}</b> {String(e.data.message ?? '')}
        </div>
      );
    case 'thought':
      return (
        <div className="ev thought">
          <span className="pill">action note</span> <b style={{ color }}>{actor?.name}</b> <i>{String(e.data.thought ?? '')}</i>
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
