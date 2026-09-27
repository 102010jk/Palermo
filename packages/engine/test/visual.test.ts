import { describe, expect, it } from 'vitest';
import { Game, VISUAL_MIN_DAY_SEC, readingTimeMs, type RoleId } from '../src/index.ts';

function setup(roles: RoleId[], startPhase: 'day' | 'night' = 'night') {
  let t = 1_000_000;
  const g = new Game('g', { roles, gameStyle: 'visual', nightTimeoutSec: null, startPhase, voteDeadlineSec: null }, { seed: 3, now: () => t });
  roles.forEach((_, i) => g.addPlayer({ id: `p${i}`, name: `P${i}`, kind: 'bot' }));
  g.start(true);
  const one = (r: RoleId) => g.state.players.find((p) => p.role === r)!;
  return { g, one, advance: (ms: number) => (t += ms) };
}

describe('visual games', () => {
  it('speak one at a time: later messages wait until the previous one has been read', () => {
    const { g, advance } = setup(['murderer', 'civilian', 'civilian', 'civilian'], 'day');
    const [a, b, c] = g.state.players;
    g.say(a.id, 'first message');
    const queued = g.say(b.id, 'second');
    expect(queued.some((e) => e.type === 'chat')).toBe(false);
    g.say(c.id, 'third');
    expect(g.tick()).toEqual([]);
    advance(readingTimeMs('first message'));
    expect(g.tick().map((e) => e.text)).toEqual([`${b.publicName}: second`]);
    advance(readingTimeMs('second'));
    expect(g.tick().map((e) => e.text)).toEqual([`${c.publicName}: third`]);
  });

  it('plays the night out for the god view before dawn, with actions locked', () => {
    const { g, one, advance } = setup(['murderer', 'doctor', 'civilian', 'civilian']);
    const c = one('civilian');
    g.nightAction(one('doctor').id, one('doctor').id);
    const ev = g.nightAction(one('murderer').id, c.id);
    const plan = ev.find((e) => e.data.kind === 'night_plan')!;
    expect(plan.vis.scope).toBe('admin');
    expect((plan.data.visits as { to: string; home: boolean }[]).filter((v) => !v.home).map((v) => v.to)).toEqual([c.id]);
    expect(g.state.phase).toBe('night');
    expect(() => g.nightAction(one('murderer').id, one('doctor').id)).toThrow(/locked/);
    advance(20_000);
    g.tick();
    expect(g.state.phase).toBe('day');
    expect(g.player(c.id)!.alive).toBe(false);
  });

  it('a day lasts at least a while even when everyone votes at once', () => {
    const { g, one, advance } = setup(['murderer', 'civilian', 'civilian', 'civilian'], 'day');
    const m = one('murderer');
    for (const p of g.state.players) g.vote(p.id, p.id === m.id ? g.state.players.find((x) => x.id !== m.id)!.id : m.id);
    expect(g.state.phase).toBe('day');
    advance((VISUAL_MIN_DAY_SEC - 1) * 1000);
    g.tick();
    expect(g.state.phase).toBe('day');
    advance(2_000);
    g.tick();
    expect(g.state.phase).toBe('ended');
  });
});

describe('games with people', () => {
  it('pace the chat and the day even in simulation style, slower than visual AI games', () => {
    let t = 1000;
    const g = new Game('h', { roles: ['murderer', 'doctor', 'civilian', 'civilian'], gameStyle: 'simulation', startPhase: 'day', voteDeadlineSec: 90, nightTimeoutSec: null }, { seed: 3, now: () => t });
    ['Jakub', 'A', 'B', 'C'].forEach((n, i) => g.addPlayer({ id: `p${i}`, name: n, kind: i === 0 ? 'human' : 'ai' }));
    g.state.players.forEach((p) => g.setReady(p.id));
    g.start();
    expect(g.hasPeople()).toBe(true);
    expect(g.view('p0').slowPace).toBe(true);
    g.say('p1', 'Hello town.');
    const second = g.say('p2', 'Hi.');
    expect(second.some((e) => e.data.kind === 'speech_queued')).toBe(true);
    expect(readingTimeMs('x'.repeat(100), true)).toBeGreaterThan(readingTimeMs('x'.repeat(100)));
    for (const p of g.alive()) g.vote(p.id, 'skip');
    expect(g.state.phase).toBe('day'); // people get at least 90 s of day
    t += 60_000;
    g.tick();
    expect(g.state.phase).toBe('day');
    t += 40_000;
    g.tick();
    expect(g.state.phase).not.toBe('day');
  });
});
