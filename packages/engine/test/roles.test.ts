import { describe, expect, it } from 'vitest';
import { Game, GameError, PASS, type GameSettings, type RoleId } from '../src/index.ts';

function setup(roles: RoleId[], settings: Partial<GameSettings> = {}) {
  let t = 1000;
  const g = new Game('g1', { roles, nightTimeoutSec: null, startPhase: 'night', ...settings }, { seed: 7, now: () => t });
  roles.forEach((_, i) => g.addPlayer({ id: `p${i}`, name: `P${i}`, kind: 'bot' }));
  g.state.players.forEach((p) => g.setReady(p.id));
  g.start();
  const one = (r: RoleId) => g.state.players.find((p) => p.role === r)!;
  const all = (r: RoleId) => g.state.players.filter((p) => p.role === r);
  const privateText = (id: string) => g.eventsFor(id).map((e) => e.text).join('\n');
  return { g, one, all, privateText, advance: (ms: number) => (t += ms) };
}

describe('murderers kill separately', () => {
  it('two murderers kill two players, never the same house, and may pass', () => {
    const { g, all } = setup(['murderer', 'murderer', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian']);
    const [m1, m2] = all('murderer');
    const [c1, c2] = all('civilian');
    g.nightAction(m1.id, c1.id);
    expect(g.required(m2.id).options).not.toContain(c1.publicName);
    expect(g.required(m2.id).options).toContain(PASS);
    expect(() => g.nightAction(m2.id, c1.id)).toThrow(/partner already goes/);
    g.nightAction(m2.id, c2.id);
    expect(g.state.phase).toBe('day');
    expect(g.player(c1.id)!.alive).toBe(false);
    expect(g.player(c2.id)!.alive).toBe(false);
  });

  it('a pass keeps the murderer home', () => {
    const { g, all, one } = setup(['murderer', 'murderer', 'tracker', 'civilian', 'civilian', 'civilian', 'civilian']);
    const [m1, m2] = all('murderer');
    const [c1] = all('civilian');
    g.nightAction(m1.id, c1.id);
    g.nightAction(m2.id, 'pass');
    g.nightAction(one('tracker').id, m2.id);
    expect(g.state.phase).toBe('day');
    expect(g.alive()).toHaveLength(6);
    expect(g.eventsFor(one('tracker').id).some((e) => e.type === 'tracker_result' && /stayed home/.test(e.text))).toBe(true);
  });
});

describe('trapper', () => {
  it('catches every visitor of the trapped house and reports their role, not their name', () => {
    const { g, one, privateText } = setup(['murderer', 'trapper', 'doctor', 'civilian', 'civilian']);
    const m = one('murderer');
    const tr = one('trapper');
    const d = one('doctor');
    const c = one('civilian');
    g.nightAction(tr.id, c.id);
    g.nightAction(d.id, c.id);
    g.nightAction(m.id, c.id);
    expect(g.player(c.id)!.alive).toBe(true);
    expect(privateText(m.id)).toMatch(/walked into a trap .* killed nobody/);
    expect(privateText(d.id)).toMatch(/walked into a trap .* protected nobody/);
    expect(privateText(tr.id)).toMatch(/caught someone last night: a (Murderer|Doctor) and a (Murderer|Doctor)/);
    const report = g.eventsFor(tr.id).find((e) => e.type === 'trap_result')!.text;
    expect(report).not.toContain(m.publicName);
    expect(report).not.toContain(d.publicName);
    // Not the same house two nights in a row.
    g.vote(m.id, 'skip');
    for (const p of g.alive().filter((x) => x.id !== m.id)) g.vote(p.id, 'skip');
    expect(g.required(tr.id).options).not.toContain(c.publicName);
  });

  it('the owner of a trapped house is not caught at home', () => {
    const { g, one } = setup(['murderer', 'trapper', 'doctor', 'civilian', 'civilian']);
    const d = one('doctor');
    g.nightAction(one('trapper').id, d.id);
    g.nightAction(d.id, d.id); // self-protect: stays home
    g.nightAction(one('murderer').id, d.id);
    expect(g.player(d.id)!.alive).toBe(true);
    expect(g.eventsFor(d.id).some((e) => e.type === 'trap_result')).toBe(false);
  });
});

describe('crazy roles', () => {
  it('a crazy murderer believes to be a murderer, stays home and kills nobody; murderers then work alone', () => {
    const { g, one, privateText } = setup(['murderer', 'crazy_murderer', 'tracker', 'civilian', 'civilian', 'civilian']);
    const m = one('murderer');
    const cm = one('crazy_murderer');
    const tr = one('tracker');
    const [c1, c2] = g.state.players.filter((p) => p.role === 'civilian');
    expect(g.view(cm.id).you!.role).toBe('murderer');
    expect(g.view(cm.id).you!.teammates).toEqual([]);
    expect(g.view(m.id).you!.teammates).toEqual([]);
    expect(g.eventsFor(c1.id).find((e) => e.type === 'game_started')!.text).toContain('2x Murderer');
    expect(() => g.say(m.id, 'hello partner')).toThrow(/work alone/);
    g.nightAction(cm.id, c1.id);
    g.nightAction(m.id, c2.id);
    g.nightAction(tr.id, cm.id);
    expect(g.player(c1.id)!.alive).toBe(true);
    expect(g.player(c2.id)!.alive).toBe(false);
    expect(privateText(tr.id)).toMatch(/stayed home/);
    // The crazy murderer is town: with the real murderer gone, town wins.
    for (const p of g.alive()) if (p.id !== m.id) g.vote(p.id, m.id);
    g.vote(m.id, tr.id);
    expect(g.state.winner).toBe('town');
    expect(privateText(cm.id)).toMatch(/you were a Crazy murderer/);
  });

  it('a crazy tracker always gets a wrong result', () => {
    for (let seed = 0; seed < 20; seed++) {
      const g = new Game('g', { roles: ['murderer', 'crazy_tracker', 'civilian', 'civilian', 'civilian'], nightTimeoutSec: null }, { seed, now: () => 1 });
      ['a', 'b', 'c', 'd', 'e'].forEach((id) => g.addPlayer({ id, name: id.toUpperCase(), kind: 'bot' }));
      g.start(true);
      const m = g.state.players.find((p) => p.role === 'murderer')!;
      const ct = g.state.players.find((p) => p.role === 'crazy_tracker')!;
      const victim = g.state.players.find((p) => p.role === 'civilian')!;
      g.nightAction(ct.id, m.id);
      g.nightAction(m.id, victim.id);
      const r = g.eventsFor(ct.id).find((e) => e.type === 'tracker_result')!;
      expect(r.data.visited).not.toBe(victim.id);
    }
  });

  it('a crazy doctor protects nobody', () => {
    const { g, one } = setup(['murderer', 'crazy_doctor', 'civilian', 'civilian', 'civilian']);
    const c = one('civilian');
    expect(g.view(one('crazy_doctor').id).you!.role).toBe('doctor');
    g.nightAction(one('crazy_doctor').id, c.id);
    g.nightAction(one('murderer').id, c.id);
    expect(g.player(c.id)!.alive).toBe(false);
  });
});

describe('gunman', () => {
  it('shoots once during the day, publicly, and the day resolves when the rest voted', () => {
    const { g, one, all } = setup(['murderer', 'gunman', 'civilian', 'civilian', 'civilian'], { startPhase: 'day' });
    const gun = one('gunman');
    const m = one('murderer');
    const [c1, c2] = all('civilian');
    expect(g.required(gun.id).dayAction?.options).toContain(m.publicName);
    g.vote(c1.id, gun.id);
    const ev = g.shoot(gun.id, c2.id);
    expect(ev.find((e) => e.type === 'shot')!.text).toContain(`${gun.publicName} is the Gunman`);
    expect(g.view(c1.id).players.find((p) => p.id === gun.id)!.role).toBe('gunman');
    expect(() => g.shoot(gun.id, m.id)).toThrow(/only bullet/);
    expect(() => g.shoot(c1.id, m.id)).toThrow(GameError);
    expect(g.required(gun.id).dayAction).toBeUndefined();
  });
});

describe('role counts and pause', () => {
  it('builds the role list from counts, the rest civilians', () => {
    const g = new Game('g', { roleCounts: { murderer: 1, trapper: 1, gunman: 1 }, nightTimeoutSec: null });
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => g.addPlayer({ id, name: id, kind: 'bot' }));
    g.start(true);
    const roles = g.state.players.map((p) => p.role).sort();
    expect(roles).toEqual(['civilian', 'civilian', 'civilian', 'gunman', 'murderer', 'trapper']);
  });

  it('pausing freezes the deadlines', () => {
    const { g, one, advance } = setup(['murderer', 'doctor', 'civilian', 'civilian'], { nightTimeoutSec: 60 });
    advance(30_000);
    g.pause('usage limit');
    advance(3_600_000);
    expect(g.tick()).toEqual([]);
    g.resume();
    advance(29_000);
    expect(g.tick()).toEqual([]);
    expect(g.state.phase).toBe('night');
    advance(2_000);
    g.tick();
    expect(g.state.phase).toBe('day');
    expect(one('murderer').alive).toBe(true);
  });
});
