import type { PlayerView } from './types.ts';

export type BotDecision =
  | { type: 'ready' }
  | { type: 'night_action'; target: string; thought: string }
  | { type: 'say'; message: string; thought: string }
  | { type: 'vote'; target: string; thought: string }
  | { type: 'mail'; a?: string; b?: string; thought: string }
  | null;

const LINES = [
  'I have a bad feeling about {x}.',
  'Has anyone noticed how quiet {x} is?',
  "I'm just a simple citizen, I trust nobody yet.",
  '{x}, where were you last night?',
  "Let's not rush. But {x} seems suspicious to me.",
];

/**
 * Scripted test bot: plays legal but naive moves. Used for engine tests, load tests and filling empty seats
 * without spending model tokens. `rand` must return [0, 1).
 */
export function botDecide(view: PlayerView, saidThisPhase: number, rand: () => number = Math.random): BotDecision {
  const req = view.required;
  const choose = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  if (req.kind === 'ready' && !req.done) return { type: 'ready' };
  if (req.kind === 'night_action' && !req.done && req.options?.length) {
    const real = req.options.filter((o) => o !== 'pass');
    return { type: 'night_action', target: real.length ? choose(real) : 'pass', thought: 'Scripted bot: random target.' };
  }
  if (req.kind === 'mail' && !req.done && req.options?.length) {
    const a = choose(req.options);
    const rest = req.options.filter((o) => o !== a);
    if (rest.length) return { type: 'mail', a, b: choose(rest), thought: 'Scripted bot: link two random players.' };
    return { type: 'mail', thought: 'Scripted bot: nobody to link.' };
  }
  if (req.kind === 'vote' && view.you?.alive) {
    const others = (req.options ?? []).filter((o) => o !== 'skip');
    if (saidThisPhase < 1 && others.length) {
      const line = choose(LINES).replace('{x}', choose(others));
      return { type: 'say', message: line, thought: 'Scripted bot: small talk.' };
    }
    if (!req.done) {
      const mates = new Set(view.you.teammates);
      const candidates = others.filter((o) => !mates.has(o));
      return { type: 'vote', target: candidates.length ? choose(candidates) : 'skip', thought: 'Scripted bot: random vote.' };
    }
  }
  return null;
}
