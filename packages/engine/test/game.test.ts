import { describe, expect, it } from 'vitest';
import { Game, GameError, botDecide, defaultRoles, type GameSettings, type RoleId } from '../src/index.ts';

function setup(roles: RoleId[], settings: Partial<GameSettings> = {}) {
  let t = 1000;
  const g = new Game('g1', { roles, nightTimeoutSec: null, ...settings }, { seed: 42, now: () => t });
  roles.forEach((_, i) => g.addPlayer({ id: `p${i}`, name: `P${i}`, kind: 'bot' }));
  g.state.players.forEach((p) => g.setReady(p.id));
  g.start();
  const byRole = (r: RoleId) => g.state.players.filter((p) => p.role === r);
  return { g, byRole, advance: (ms: number) => (t += ms) };
}

describe('role table', () => {
  it('scales murderers with player count', () => {
    expect(defaultRoles(6).filter((r) => r === 'murderer')).toHaveLength(1);
    expect(defaultRoles(9).filter((r) => r === 'murderer')).toHaveLength(2);
    expect(defaultRoles(6)).toContain('tracker');
    expect(defaultRoles(6)).toContain('doctor');
    expect(defaultRoles(4)).not.toContain('tracker');
  });
});

describe('lobby', () => {
  it('requires everyone ready unless forced', () => {
    const g = new Game('g', { minPlayers: 3 });
    ['a', 'b', 'c'].forEach((n) => g.addPlayer({ id: n, name: n, kind: 'bot' }));
    expect(g.canStart().ok).toBe(false);
    expect(g.canStart(true).ok).toBe(true);
  });

  it('rejects duplicate names', () => {
    const g = new Game('g');
    g.addPlayer({ id: 'a', name: 'Opus', kind: 'ai' });
    expect(() => g.addPlayer({ id: 'b', name: 'opus', kind: 'ai' })).toThrow(GameError);
  });

  it('gives aliases in anonymous games and hides identity', () => {
    const g = new Game('g', { identityVisibility: 'anonymous' }, { seed: 1 });
    ['Opus', 'Haiku', 'Flash'].forEach((n, i) => g.addPlayer({ id: `p${i}`, name: n, kind: 'ai', model: n }));
    g.start(true);
    const v = g.view('p0');
    const other = v.players.find((p) => p.id !== 'p0')!;
    expect(other.model).toBeUndefined();
    expect(['Opus', 'Haiku', 'Flash']).not.toContain(other.name);
    expect(g.view(null).players.every((p) => p.model)).toBe(true);
    // The lobby log (with real names) is hidden from players once the game runs.
    expect(g.eventsFor('p0').some((e) => e.text.includes('Haiku joined'))).toBe(false);
    expect(g.eventsFor(null).some((e) => e.text.includes('Haiku joined'))).toBe(true);
  });
});

describe('night', () => {
  it('murderer kills an unprotected target', () => {
    const { g, byRole } = setup(['murderer', 'doctor', 'tracker', 'civilian', 'civilian', 'civilian']);
    const [m] = byRole('murderer');
    const [d] = byRole('doctor');
    const [t] = byRole('tracker');
    const [c1, c2] = byRole('civilian');
    g.nightAction(m.id, c1.publicName);
    g.nightAction(d.id, c2.publicName);
    g.nightAction(t.id, m.publicName);
    expect(g.state.phase).toBe('day');
    expect(g.player(c1.id)!.alive).toBe(false);
    const tr = g.eventsFor(t.id).find((e) => e.type === 'tracker_result')!;
    expect(tr.text).toContain(`visited ${c1.publicName}`);
  });

  it('doctor saves the target and learns about it', () => {
    const { g, byRole } = setup(['murderer', 'doctor', 'tracker', 'civilian', 'civilian', 'civilian']);
    const [m] = byRole('murderer');
    const [d] = byRole('doctor');
    const [t] = byRole('tracker');
    const [c1] = byRole('civilian');
    g.nightAction(m.id, c1.id);
    g.nightAction(d.id, c1.id);
    g.nightAction(t.id, d.id);
    expect(g.player(c1.id)!.alive).toBe(true);
    expect(g.eventsFor(d.id).some((e) => e.type === 'doctor_result')).toBe(true);
    expect(g.eventsFor(t.id).find((e) => e.type === 'tracker_result')!.text).toContain(`visited ${c1.publicName}`);
    // civilians do not learn who was attacked
    expect(g.eventsFor(c1.id).some((e) => e.type === 'doctor_result' || e.type === 'night_action')).toBe(false);
  });

  it('doctor cannot protect the same player twice in a row', () => {
    const { g, byRole } = setup(['murderer', 'doctor', 'civilian', 'civilian', 'civilian'], { roles: ['murderer', 'doctor', 'civilian', 'civilian', 'civilian'] });
    const [m] = byRole('murderer');
    const [d] = byRole('doctor');
    const cs = byRole('civilian');
    g.nightAction(m.id, cs[0].id);
    g.nightAction(d.id, cs[1].id);
    // day: everyone skips
    for (const p of g.alive()) g.vote(p.id, 'skip');
    expect(g.state.phase).toBe('night');
    expect(() => g.nightAction(d.id, cs[1].id)).toThrow(GameError);
  });

  it('only murderers can talk at night and only murderers see it', () => {
    const { g, byRole } = setup(['murderer', 'murderer', 'doctor', 'tracker', 'civilian', 'civilian', 'civilian']);
    const [m1, m2] = byRole('murderer');
    const [c] = byRole('civilian');
    g.say(m1.id, 'Lets hit the doctor');
    expect(() => g.say(c.id, 'hello?')).toThrow(GameError);
    expect(g.eventsFor(m2.id).some((e) => e.type === 'team_chat')).toBe(true);
    expect(g.eventsFor(c.id).some((e) => e.type === 'team_chat')).toBe(false);
  });

  it('murderers see each other in their view', () => {
    const { g, byRole } = setup(['murderer', 'murderer', 'doctor', 'tracker', 'civilian', 'civilian', 'civilian']);
    const [m1, m2] = byRole('murderer');
    const v = g.view(m1.id);
    expect(v.you!.teammates).toEqual([m2.publicName]);
    expect(v.players.find((p) => p.id === m2.id)!.role).toBe('murderer');
    const [c] = byRole('civilian');
    expect(g.view(c.id).players.find((p) => p.id === m1.id)!.role).toBeUndefined();
  });

  it('resolves on timeout with partial actions', () => {
    const { g, byRole, advance } = setup(['murderer', 'doctor', 'civilian', 'civilian'], { nightTimeoutSec: 60 });
    const [m] = byRole('murderer');
    const [c] = byRole('civilian');
    g.nightAction(m.id, c.id);
    expect(g.tick()).toEqual([]);
    advance(61_000);
    g.tick();
    expect(g.state.phase).toBe('day');
    expect(g.player(c.id)!.alive).toBe(false);
  });
});

describe('day', () => {
  function toDay() {
    const s = setup(['murderer', 'doctor', 'tracker', 'civilian', 'civilian', 'civilian']);
    const [m] = s.byRole('murderer');
    const [d] = s.byRole('doctor');
    const [t] = s.byRole('tracker');
    const cs = s.byRole('civilian');
    s.g.nightAction(m.id, cs[0].id);
    s.g.nightAction(d.id, t.id);
    s.g.nightAction(t.id, m.id);
    return { ...s, m, d, t, cs };
  }

  it('day ends only when everyone alive has voted; votes can change', () => {
    const { g, m, d, t, cs } = toDay();
    g.vote(d.id, cs[1].id);
    g.vote(d.id, m.id); // change
    g.vote(t.id, m.id);
    g.vote(cs[1].id, m.id);
    expect(g.state.phase).toBe('day');
    g.vote(cs[2].id, t.id);
    g.vote(m.id, t.id);
    expect(g.state.phase).toBe('ended');
    expect(g.state.winner).toBe('town');
  });

  it('tie means no elimination', () => {
    const { g, m, d, t, cs } = toDay();
    g.vote(d.id, m.id);
    g.vote(t.id, m.id);
    g.vote(cs[1].id, cs[2].id);
    g.vote(cs[2].id, cs[1].id);
    g.vote(m.id, cs[2].id);
    expect(g.state.phase).toBe('night');
    expect(g.alive()).toHaveLength(5);
  });

  it('cannot vote for self or dead players', () => {
    const { g, d, cs } = toDay();
    expect(() => g.vote(d.id, d.id)).toThrow(GameError);
    expect(() => g.vote(d.id, cs[0].id)).toThrow(/dead/);
  });

  it('mafia wins at parity', () => {
    const { g, m, d, t, cs } = toDay();
    // eliminate tracker
    for (const p of [m, d, cs[1], cs[2]]) g.vote(p.id, t.id);
    g.vote(t.id, m.id);
    expect(g.state.phase).toBe('night');
    // night 2: kill doctor -> alive: m, c1, c2 -> 1 vs 2 continue
    g.nightAction(m.id, d.id);
    g.nightAction(d.id, cs[1].id);
    expect(g.state.phase).toBe('day');
    for (const p of [m, cs[2]]) g.vote(p.id, cs[1].id);
    g.vote(cs[1].id, m.id);
    expect(g.state.winner).toBe('mafia');
  });
});

describe('bots', () => {
  it('scripted bots can finish many games', () => {
    for (let seed = 1; seed <= 50; seed++) {
      let t = 0;
      const n = 5 + (seed % 6);
      const g = new Game(`g${seed}`, { nightTimeoutSec: null }, { seed, now: () => t++ });
      for (let i = 0; i < n; i++) g.addPlayer({ id: `p${i}`, name: `Bot${i}`, kind: 'bot' });
      let r = seed;
      const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
      const said = new Map<string, number>();
      let lastPhase = '';
      for (let step = 0; step < 5000 && g.state.phase !== 'ended'; step++) {
        const key = `${g.state.phase}${g.state.round}`;
        if (key !== lastPhase) {
          said.clear();
          lastPhase = key;
        }
        let acted = false;
        for (const p of g.state.players) {
          const d = botDecide(g.view(p.id), said.get(p.id) ?? 0, rand);
          if (!d) continue;
          acted = true;
          if (d.type === 'ready') g.setReady(p.id);
          else if (d.type === 'night_action') g.nightAction(p.id, d.target, d.thought);
          else if (d.type === 'vote') g.vote(p.id, d.target, d.thought);
          else if (d.type === 'say') {
            g.say(p.id, d.message, d.thought);
            said.set(p.id, (said.get(p.id) ?? 0) + 1);
          }
          if ((g.state.phase as string) === 'ended') break;
        }
        if (g.state.phase === 'lobby' && g.canStart().ok) g.start();
        if (!acted && g.state.phase !== 'lobby') break;
      }
      expect(g.state.phase).toBe('ended');
      expect(g.state.winner).not.toBeNull();
    }
  });
});
