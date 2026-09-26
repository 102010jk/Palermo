import { useCallback, useEffect, useRef, useState } from 'react';
import { readingTimeMs, type GameEvent, type PublicPlayer } from '@palermo/engine';
import { Character, LOOKS, lookFor } from './Sprites.tsx';

/** One line on the stage: a chat message (or mafia night chat) shown on its own, long enough to read. */
export interface StageLine {
  seq: number;
  actor: string;
  text: string;
  kind: 'chat' | 'team';
  /** Ventriloquist: who really said it (god view only). */
  forgedBy?: string;
  /** God view: what the speaker thought right before saying it. */
  thought?: string;
  thinker?: string;
  ms: number;
}

export interface StageState {
  current: (StageLine & { start: number }) | null;
  /** The current line is still within its reading time. */
  speaking: boolean;
  queued: StageLine[];
  push: (events: GameEvent[]) => void;
  /** Clear the stage; lines up to `seenSeq` are history and will not be played. */
  reset: (seenSeq?: number) => void;
}

/**
 * Plays chat messages strictly one after another, each for its reading time, however they arrive (the server paces
 * day chat already, but night chat, forged lines and reconnects can come in bursts). The last line stays visible
 * until the next one replaces it, so nothing disappears before it has been read.
 */
export function useStage(): StageState {
  const [current, setCurrent] = useState<StageState['current']>(null);
  const [queued, setQueued] = useState<StageLine[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const queue = useRef<StageLine[]>([]);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thoughts = useRef(new Map<string, { text: string; at: number }>());
  const lastSeq = useRef(0);

  const advance = useCallback(() => {
    const next = queue.current.shift();
    setQueued([...queue.current]);
    if (!next) {
      busy.current = false;
      setSpeaking(false);
      return;
    }
    busy.current = true;
    setSpeaking(true);
    setCurrent({ ...next, start: Date.now() });
    // Catch up when many lines are waiting, but never faster than half the reading time.
    const factor = queue.current.length >= 4 ? 0.5 : queue.current.length >= 2 ? 0.75 : 1;
    timer.current = setTimeout(advance, next.ms * factor);
  }, []);

  const push = useCallback(
    (events: GameEvent[]) => {
      const lines: StageLine[] = [];
      const forged = new Map(events.filter((e) => e.data.kind === 'forged').map((e) => [Number(e.data.chatSeq), String(e.data.by)]));
      for (const e of events) {
        if (e.seq <= lastSeq.current) continue;
        lastSeq.current = e.seq;
        if (e.type === 'thought' && e.actor) {
          thoughts.current.set(e.actor, { text: String(e.data.thought ?? ''), at: e.at });
          continue;
        }
        if ((e.type !== 'chat' && e.type !== 'team_chat') || !e.actor || e.phase === 'lobby') continue;
        const text = String(e.data.message ?? '');
        const forgedBy = forged.get(e.seq);
        const thinker = forgedBy ?? e.actor;
        const t = thoughts.current.get(thinker);
        thoughts.current.delete(thinker);
        lines.push({
          seq: e.seq,
          actor: e.actor,
          text,
          kind: e.type === 'chat' ? 'chat' : 'team',
          forgedBy,
          thought: t && e.at - t.at < 5 * 60_000 ? t.text : undefined,
          thinker,
          ms: readingTimeMs(text),
        });
      }
      if (!lines.length) return;
      queue.current.push(...lines);
      if (!busy.current) advance();
      else setQueued([...queue.current]);
    },
    [advance],
  );

  const reset = useCallback((seenSeq = 0) => {
    if (timer.current) clearTimeout(timer.current);
    queue.current = [];
    busy.current = false;
    lastSeq.current = seenSeq;
    thoughts.current.clear();
    setQueued([]);
    setCurrent(null);
    setSpeaking(false);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { current, speaking, queued, push, reset };
}

interface Props {
  line: StageState['current'];
  speaking: boolean;
  queued: StageLine[];
  /** Names still waiting on the server for the floor (after the queued lines). */
  waiting?: string[];
  players: PublicPlayer[];
  godView: boolean;
  /** Replays show the latest line without a timer. */
  still?: boolean;
}

/** The subtitle panel under the town: who is speaking now, the whole message, and who is next in line. */
export function Stage({ line, speaking, queued, waiting = [], players, godView, still }: Props) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!line || still || !speaking) return;
    const t = setInterval(() => force((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [line, still]);

  const who = (id: string | undefined) => players.find((p) => p.id === id);
  if (!line) {
    return (
      <div className="stage empty">
        <span className="muted">Nobody is speaking.</span>
      </div>
    );
  }
  const speaker = who(line.actor);
  const look = speaker ? lookFor(speaker) : 'unknown';
  const color = LOOKS[look]?.color;
  const progress = still || !speaking ? 1 : Math.min(1, (Date.now() - line.start) / line.ms);
  const real = line.forgedBy ? who(line.forgedBy) : undefined;
  const thinker = who(line.thinker);
  const next = [...queued.map((q) => who(q.actor)?.name ?? '?'), ...waiting];
  return (
    <div className={`stage ${line.kind} ${line.forgedBy && godView ? 'forged' : ''} ${speaking || still ? '' : 'done'}`} key={line.seq}>
      <div className="stage-avatar">{speaker && <Character look={look} scale={3} className="talk" />}</div>
      <div className="stage-body">
        <div className="stage-who">
          <b style={{ color }}>{speaker?.name ?? '?'}</b>
          {line.kind === 'team' && <span className="pill">mafia, at night</span>}
          {line.forgedBy && godView && <span className="pill forged-pill">🗣 forged by {real?.name ?? '?'}</span>}
        </div>
        <p className="stage-text">{line.text}</p>
        {godView && line.thought && (
          <p className="stage-thought">
            💭 {line.forgedBy ? `${thinker?.name ?? '?'} thought: ` : ''}
            <i>{line.thought}</i>
          </p>
        )}
        <div className="stage-foot">
          <span className="stage-bar">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
          {next.length > 0 && (
            <span className="stage-next muted small">
              next: {next.slice(0, 4).join(', ')}
              {next.length > 4 ? ` +${next.length - 4}` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
