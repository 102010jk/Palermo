import type { CSSProperties } from 'react';
import { ROLES, type PublicPlayer } from '@palermo/engine';
import { Character, Cottage, Fountain, Grave, Lamp, LOOKS, lookFor } from './Sprites.tsx';

export type BubbleKind = 'chat' | 'team' | 'thought';
export interface Bubble {
  text: string;
  kind: BubbleKind;
  at: number;
  /** Ventriloquist: the player who really said it (god view only). */
  forgedBy?: string;
}

/** One step of the god-view night animation: a player walks to a house, acts, walks back. */
export interface NightStep {
  actor: string;
  to: string;
  kind: string;
  stage: 'go' | 'act' | 'back';
  caught: boolean;
}

const ROOFS = ['#b4533c', '#6d8a3a', '#3d6fa8', '#8a4f9e', '#c28a2c', '#4b8c8a', '#a2463f', '#5d6aa8'];
const ACTION_ICON: Record<string, string> = { kill: '🔪', protect: '✚', track: '👁', trap: '🪤' };
const ACTION_CLASS: Record<string, string> = { kill: 'kill', protect: 'protect', track: 'track', trap: 'trap' };
const ACTION_VERB: Record<string, string> = {
  kill: 'sneaks up on',
  protect: 'watches over',
  track: 'follows',
  trap: 'sets a trap at the door of',
};

interface Props {
  players: PublicPlayer[];
  phase: string;
  night: boolean;
  isAlive: (p: PublicPlayer) => boolean;
  meId?: string;
  bubbles: Record<string, Bubble>;
  /** voterId -> target playerId (or 'skip'). */
  votes: Record<string, string>;
  selected: string | null;
  canTarget: (p: PublicPlayer) => boolean;
  onSelect: (name: string) => void;
  godView: boolean;
  step: NightStep | null;
  /** Houses with a trap tonight (god view). */
  traps: Set<string>;
  /** Player just shot (flash). */
  shotId?: string | null;
}

/** Ellipse point in percent of the scene (angle 0 = top, clockwise). */
function at(i: number, n: number, rx: number, ry: number): { x: number; y: number } {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, n);
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

/**
 * The visual-mode town: cottages in a ring around a square with a fountain. By day the players gather on the square,
 * at night they stay home; in the god view they walk to the houses they visit, one after another.
 */
export function TownRing(props: Props) {
  const { players, night, phase } = props;
  const n = players.length;
  const scale = n <= 8 ? 4.2 : n <= 10 ? 3.6 : n <= 14 ? 2.8 : 2.2;
  const charScale = n <= 8 ? 4 : n <= 10 ? 3.5 : n <= 14 ? 2.8 : 2.3;
  const index = new Map(players.map((p, i) => [p.id, i]));
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? '?';
  const house = (i: number) => at(i, n, 40, 38);
  // Owners stand to the right of their house, visitors to the left of the house they visit.
  const houseHalf = (22 * scale) / 2 / 12.8 + (12 * charScale) / 2 / 12.8 + 0.6;
  const door = (i: number) => {
    const h = house(i);
    return { x: h.x + houseHalf, y: h.y + 1 };
  };
  const visitorSpot = (i: number) => {
    const h = house(i);
    return { x: h.x - houseHalf, y: h.y + 1 };
  };
  const square = (i: number) => at(i, n, 17, 16);
  const onSquare = phase === 'day' || phase === 'ended';

  const posOf = (p: PublicPlayer, i: number) => {
    const s = props.step;
    if (s && s.actor === p.id && s.stage !== 'back') {
      return visitorSpot(index.get(s.to) ?? i);
    }
    return onSquare && props.isAlive(p) ? square(i) : door(i);
  };

  // Vote arrows between square positions.
  const arrows = Object.entries(props.votes)
    .filter(([, t]) => t !== 'skip' && index.has(t))
    .map(([v, t]) => ({ v, t, from: square(index.get(v) ?? 0), to: square(index.get(t) ?? 0) }))
    .filter((a) => index.has(a.v));
  const voteCount = new Map<string, number>();
  for (const [, t] of Object.entries(props.votes)) voteCount.set(t, (voteCount.get(t) ?? 0) + 1);

  return (
    <div className={`ring-town ${night ? 'is-night' : 'is-day'} phase-${phase}`}>
      <div className="plaza" />
      <div className="plaza-center" style={{ left: '50%', top: '50%' }}>
        <Fountain scale={n <= 10 ? 5 : 4} night={night} />
      </div>
      {[0, 1, 2, 3].map((k) => {
        const p = at(k * 2 + 1, 8, 23, 22);
        return (
          <div key={k} className="lamp" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
            <Lamp night={night} scale={2.5} />
          </div>
        );
      })}

      {/* Houses */}
      {players.map((p, i) => {
        const h = house(i);
        const alive = props.isAlive(p);
        const look = lookFor(p);
        return (
          <div
            key={`h-${p.id}`}
            className={`ring-house ${alive ? '' : 'dead'} ${props.traps.has(p.id) ? 'trapped' : ''} ${props.step?.to === p.id ? 'visited' : ''}`}
            style={{ left: `${h.x}%`, top: `${h.y}%`, zIndex: Math.round(h.y) }}
          >
            <Cottage variant={i} night={night} dead={!alive} scale={scale} roof={ROOFS[i % ROOFS.length]} />
            {props.traps.has(p.id) && <span className="trap-mark" title="Trap">🪤</span>}
            <span className="nametag" style={{ borderColor: LOOKS[look].color }}>
              {p.name}
              {p.id === props.meId ? ' (you)' : ''}
            </span>
            <span className="modeltag">{p.kind === 'human' ? 'human' : p.model ?? (p.kind ? LOOKS[look].label : '???')}</span>
            {p.role && <span className={`roletag ${p.role}`}>{ROLES[p.role].name}</span>}
            {phase === 'lobby' && <span className={`readytag ${p.ready ? 'on' : ''}`}>{p.ready ? 'ready' : 'not ready'}</span>}
          </div>
        );
      })}

      {/* Vote arrows (by day) */}
      {onSquare && arrows.length > 0 && (
        <svg className="vote-arrows" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffdf8a" />
            </marker>
          </defs>
          {arrows.map((a) => {
            // Stop short of the target so the arrowhead stays visible.
            const dx = a.to.x - a.from.x;
            const dy = a.to.y - a.from.y;
            const len = Math.hypot(dx, dy) || 1;
            const k = Math.max(0, (len - 3) / len);
            return (
              <line
                key={a.v}
                x1={a.from.x}
                y1={a.from.y}
                x2={a.from.x + dx * k}
                y2={a.from.y + dy * k}
                stroke={LOOKS[lookFor(players[index.get(a.v)!])].color}
                strokeWidth={2.5}
                strokeDasharray="6 4"
                markerEnd="url(#arrow)"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
      )}

      {/* People */}
      {players.map((p, i) => {
        const alive = props.isAlive(p);
        const pos = posOf(p, i);
        const bubble = props.bubbles[p.id];
        const look = lookFor(p);
        const target = props.canTarget(p);
        const step = props.step?.actor === p.id ? props.step : null;
        const walking = !!step;
        const hidden = night && alive && !props.godView && !walking;
        const votes = voteCount.get(p.id) ?? 0;
        const speaking = !!bubble && bubble.kind !== 'thought';
        const style: CSSProperties = { left: `${pos.x}%`, top: `${pos.y}%`, zIndex: (speaking ? 1000 : 100) + Math.round(pos.y) };
        return (
          <button
            key={`c-${p.id}`}
            className={`ring-person ${alive ? '' : 'dead'} ${hidden ? 'inside' : ''} ${walking ? 'walking' : ''} ${p.id === props.meId ? 'me' : ''} ${
              props.selected === p.name ? 'selected' : ''
            } ${target ? 'targetable' : ''} ${props.shotId === p.id ? 'shot' : ''}`}
            style={style}
            onClick={() => target && props.onSelect(p.name)}
            disabled={!target}
            title={p.realName ?? p.name}
          >
            {/* Thoughts are only a marker (hover to read); the full text of the current speaker is on the stage. */}
            {bubble && !hidden && bubble.kind === 'thought' && (
              <span className="think-mark" title={bubble.text}>
                💭
              </span>
            )}
            {bubble && !hidden && bubble.kind !== 'thought' && (
              <span className={`bubble ${bubble.kind} ${bubble.forgedBy && props.godView ? 'forged' : ''}`}>
                {bubble.text.length > 90 ? `${bubble.text.slice(0, 90)}…` : bubble.text}
                {bubble.forgedBy && props.godView && <span className="forged-by">🗣 really {nameOf(bubble.forgedBy)}</span>}
              </span>
            )}
            {votes > 0 && onSquare && <span className="vote-badge">{votes}</span>}
            {step?.stage === 'act' && (
              <span className={`action-icon ${ACTION_CLASS[step.kind] ?? ''} ${step.caught ? 'caught' : ''}`}>
                {step.caught ? '🪤' : ACTION_ICON[step.kind] ?? '•'}
              </span>
            )}
            <span className="figure">
              {alive ? (
                <Character look={look} scale={charScale} className={bubble && bubble.kind !== 'thought' ? 'talk' : night ? '' : 'bob'} style={{ animationDelay: `${(i % 5) * 0.2}s` }} />
              ) : (
                <Grave scale={charScale * 0.8} />
              )}
            </span>
            {night && alive && !walking && !props.godView && <span className="zzz">z</span>}
            {(onSquare || walking) && alive && <span className="person-name">{p.name}</span>}
          </button>
        );
      })}
      {props.step && props.step.stage !== 'back' && (
        <div className={`night-caption ${props.step.kind}`}>
          {ACTION_ICON[props.step.kind]} <b>{nameOf(props.step.actor)}</b> {ACTION_VERB[props.step.kind] ?? 'visits'} <b>{nameOf(props.step.to)}</b>
          {props.step.stage === 'act' && props.step.caught ? ' … and walks into a trap!' : ''}
        </div>
      )}
      {!players.length && <p className="empty-town">The town is empty. Waiting for players…</p>}
    </div>
  );
}
