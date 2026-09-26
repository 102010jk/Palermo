import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playBotOverMcp } from '../../runner/src/adapters/bot.ts';
import { createPalermo, type PalermoApp } from '../src/app.ts';
import { computeStats } from '../src/stats.ts';

const ADMIN = 'test-admin-token';
let app: PalermoApp;
let base: string;

async function api(method: string, path: string, body?: unknown, token = ADMIN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  app = createPalermo({
    dataPath: ':memory:',
    adminToken: ADMIN,
    googleClientId: null,
    allowGuests: true,
    webDist: null,
    manager: { botDelayMs: [5, 20], tickMs: 50, quietMs: 150, minWaitSec: 1 },
  });
  await new Promise<void>((r) => app.http.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

describe('server', () => {
  it('rejects MCP calls without a token and admin calls from agents', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    const agent = await api('POST', '/api/admin/agents', { name: 'Sneaky', model: 'x' });
    const forbidden = await api('POST', '/api/games', { settings: {} }, agent.body.token);
    expect(forbidden.status).toBe(403);
    const audit = await api('GET', '/api/admin/audit');
    expect(audit.body.some((a: any) => a.kind === 'forbidden_admin')).toBe(true);
  });

  it('plays a full game: MCP agents + server bots, then reports and stats', async () => {
    const created = await api('POST', '/api/games', {
      settings: { autoStart: true, seats: 6, nightTimeoutSec: 20, identityVisibility: 'visible' },
    });
    expect(created.status).toBe(200);
    const gameId = created.body.id as string;

    const agents = await Promise.all(
      ['Opus', 'Haiku', 'Flash'].map((name) => api('POST', '/api/admin/agents', { name, provider: 'test', model: `${name}-model` })),
    );
    await api('POST', `/api/games/${gameId}/bots`, { count: 3 });

    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const results = await Promise.all(
      agents.map((a, i) =>
        playBotOverMcp({ mcpUrl: `${base}/mcp`, token: a.body.token, gameId, name: ['Opus', 'Haiku', 'Flash'][i], rand }),
      ),
    );
    expect(results.every((r) => r.finished)).toBe(true);

    const final = await api('GET', `/api/games/${gameId}`);
    expect(final.body.view.phase).toBe('ended');
    expect(final.body.reports).toHaveLength(3);
    // Admin sees thoughts, a spectator does not.
    expect(final.body.events.some((e: any) => e.type === 'thought')).toBe(true);
    const spectator = await fetch(`${base}/api/games/${gameId}`).then((r) => r.json());
    expect(spectator.events.some((e: any) => e.type === 'thought')).toBe(false);

    // The runner can correct the model name to what the CLI actually resolved.
    const patched = await api('PATCH', `/api/admin/agents/${agents[0].body.account.id}`, { model: 'Opus-model-5' });
    expect(patched.body.model).toBe('Opus-model-5');

    const stats = computeStats(app.db);
    expect(stats.games).toBe(1);
    expect(stats.byModel.find((b) => b.key === 'test:Opus-model-5')?.games).toBe(1);
    const filtered = computeStats(app.db, { settings: { identityVisibility: 'anonymous' } });
    expect(filtered.games).toBe(0);
    // Line-up is derived from the seats and filterable like a setting.
    expect(stats.settingValues.lineupKind).toEqual(['multi-provider']);
    expect(stats.settingValues.lineup[0]).toContain('Scripted bot ×3');
    expect(computeStats(app.db, { settings: { lineupKind: 'single-model' } }).games).toBe(0);
  });

  it('plays a full game through the stdio bridge (the path Claude Code uses)', async () => {
    const created = await api('POST', '/api/games', { settings: { autoStart: true, seats: 4, nightTimeoutSec: 20 } });
    const gameId = created.body.id as string;
    const agents = await Promise.all(['B1', 'B2', 'B3', 'B4'].map((name) => api('POST', '/api/admin/agents', { name, model: 'bridge-bot' })));
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const results = await Promise.all(
      agents.map((a, i) => playBotOverMcp({ mcpUrl: `${base}/mcp`, token: a.body.token, gameId, name: `B${i + 1}`, rand, viaBridge: true })),
    );
    expect(results.every((r) => r.finished)).toBe(true);
    const final = await api('GET', `/api/games/${gameId}`);
    expect(final.body.view.phase).toBe('ended');
    expect(final.body.reports).toHaveLength(4);
  });

  it('wakes a waiting agent when the chat goes quiet, even below its message threshold', async () => {
    const g = app.manager.create({});
    const a = app.manager.join(g.state.id, { name: 'Waiter', kind: 'ai' });
    const b = app.manager.join(g.state.id, { name: 'Talker', kind: 'ai' });
    app.manager.takeNewEvents(g.state.id, a); // skip the join events
    const t = Date.now();
    const waiting = app.manager.waitForEvents(g.state.id, a, { maxWaitSec: 20, minMessages: 5, wakeOnMention: false });
    app.manager.apply(g.state.id, (game) => game.say(b, 'hello'));
    const events = await waiting;
    expect(events.some((e) => e.type === 'chat')).toBe(true);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('keeps hidden information out of player and spectator views while running', async () => {
    const created = await api('POST', '/api/games', { settings: { nightTimeoutSec: null } });
    const gameId = created.body.id;
    const guest = await api('POST', '/api/auth/guest', { name: 'Jakub' });
    await api('POST', `/api/games/${gameId}/join`, {}, guest.body.token);
    await api('POST', `/api/games/${gameId}/bots`, { count: 4 });
    await api('POST', `/api/games/${gameId}/ready`, {}, guest.body.token);
    const start = await api('POST', `/api/games/${gameId}/start`, {});
    expect(start.status).toBe(200);
    const mine = await api('GET', `/api/games/${gameId}`, undefined, guest.body.token);
    expect(mine.body.view.you.role).toBeTruthy();
    const others = mine.body.view.players.filter((p: any) => p.id !== mine.body.view.you.id);
    if (mine.body.view.you.role !== 'murderer') expect(others.every((p: any) => !p.role)).toBe(true);
    const spectator = await fetch(`${base}/api/games/${gameId}`).then((r) => r.json());
    expect(spectator.view.players.every((p: any) => !p.role || !p.alive)).toBe(true);
    expect(spectator.events.some((e: any) => e.type === 'role_assigned')).toBe(false);
    await api('POST', `/api/games/${gameId}/abort`, {});
  });

  it('seats waiting AI players from the pool only in lobbies open to it, up to the free seats', async () => {
    for (const g of (await api('GET', '/api/games')).body) if (g.phase === 'lobby') await api('POST', `/api/games/${g.id}/abort`, {});
    const closed = (await api('POST', '/api/games', { settings: { mode: 'pool-closed', seats: 3, aiPool: false } })).body.id;
    const open = (await api('POST', '/api/games', { settings: { mode: 'pool-open', seats: 2 } })).body.id;
    await api('POST', '/api/admin/pool/picks', { provider: 'bot', model: 'script', label: 'Bot', count: 3, repeat: false });
    const hello = await api('POST', '/api/admin/pool/hello', { host: 'test', catalog: [{ provider: 'bot', model: 'script', label: 'Bot' }] });
    const assigned = hello.body.assignments.filter((a: { gameId: string }) => a.gameId === open || a.gameId === closed);
    expect(assigned.map((a: { gameId: string }) => a.gameId)).toEqual([open, open]);
    // The launcher has not seated them yet: the seats stay reserved, so a second poll assigns nobody else there.
    const again = await api('POST', '/api/admin/pool/hello', { host: 'test', running: assigned.map((a: { pickId: string }) => a.pickId) });
    expect(again.body.assignments.filter((a: { gameId: string }) => a.gameId === open)).toEqual([]);
    const status = (await api('GET', '/api/admin/pool')).body;
    expect(status.online).toBe(true);
    expect(status.picks.filter((p: { status: string }) => p.status === 'waiting')).toHaveLength(1);
    // Without repeat, a finished pick leaves the list.
    await api('POST', '/api/admin/pool/finish', { pickId: assigned[0].pickId });
    expect((await api('GET', '/api/admin/pool')).body.picks).toHaveLength(2);
    await api('POST', `/api/games/${closed}/abort`, {});
    await api('POST', `/api/games/${open}/abort`, {});
  });

  it('puts an AI player back on the waiting list and cancels its CLI when the game starts without it', async () => {
    for (const g of (await api('GET', '/api/games')).body) if (g.phase === 'lobby') await api('POST', `/api/games/${g.id}/abort`, {});
    const game = (await api('POST', '/api/games', { settings: { mode: 'pool-late', seats: 3 } })).body.id;
    await api('POST', '/api/admin/pool/picks', { provider: 'bot', model: 'script', label: 'Late bot', repeat: true });
    const late = (await api('POST', '/api/admin/pool/hello', { host: 'test' })).body.assignments.find((a: { gameId: string }) => a.gameId === game);
    expect(late).toBeTruthy();
    // Humans/bots fill the table and the host starts before the agent sat down.
    await api('POST', `/api/games/${game}/bots`, { count: 3 });
    await api('POST', `/api/games/${game}/start`, { force: true });
    const r = (await api('POST', '/api/admin/pool/hello', { host: 'test', running: [late.pickId] })).body;
    expect(r.cancel).toEqual([late.pickId]);
    expect(r.assignments.some((a: { pickId: string }) => a.pickId === late.pickId)).toBe(false);
    const pick = (await api('GET', '/api/admin/pool')).body.picks.find((p: { id: string }) => p.id === late.pickId);
    expect(pick.status).toBe('waiting');
    // A late "finished" report from the stopped CLI changes nothing.
    await api('POST', '/api/admin/pool/finish', { pickId: late.pickId, gameId: game, error: 'boom' });
    expect((await api('GET', '/api/admin/pool')).body.picks.find((p: { id: string }) => p.id === late.pickId).status).toBe('waiting');
    await api('DELETE', `/api/admin/pool/picks/${late.pickId}`);
    await api('POST', `/api/games/${game}/abort`, {});
  });

  it('deletes a stopped game with everything recorded about it, but not a running one', async () => {
    const id = (await api('POST', '/api/games', { settings: { mode: 'to-delete', seats: 3 } })).body.id;
    await api('POST', `/api/games/${id}/bots`, { count: 3 });
    await api('POST', `/api/games/${id}/start`, { force: true });
    expect((await api('DELETE', `/api/games/${id}`)).status).toBe(400);
    await api('POST', `/api/games/${id}/abort`, {});
    expect((await api('DELETE', `/api/games/${id}`)).status).toBe(200);
    expect((await api('GET', `/api/games/${id}`)).status).toBe(404);
    expect((await api('GET', '/api/games')).body.some((g: { id: string }) => g.id === id)).toBe(false);
    expect(app.db.sql.prepare('SELECT COUNT(*) AS n FROM events WHERE game_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('a series opens the next game when one ends and stops when a game is stopped', async () => {
    for (const g of (await api('GET', '/api/games')).body) if (g.phase === 'lobby') await api('POST', `/api/games/${g.id}/abort`, {});
    const r = await api('POST', '/api/admin/series', { count: 3, settings: { mode: 'series-t', seats: 3, roleCounts: { murderer: 1 } } });
    expect(r.status).toBe(200);
    const first = r.body.firstGame;
    expect((await api('GET', `/api/games/${first}`)).body.view.settings.series).toBe(r.body.id);
    // Finish the first game with bots, then the series opens game 2.
    await api('POST', `/api/games/${first}/bots`, { count: 3 });
    await api('POST', `/api/games/${first}/start`, { force: true });
    for (let i = 0; i < 200 && (await api('GET', `/api/games/${first}`)).body.view.phase !== 'ended'; i++) await new Promise((res) => setTimeout(res, 50));
    app.pool.watch();
    let series = (await api('GET', '/api/admin/pool')).body.series.find((x: { id: string }) => x.id === r.body.id);
    expect(series.gameIds).toHaveLength(2);
    expect(series.done).toBe(1);
    // Stopping a game of the series stops the series.
    await api('POST', `/api/games/${series.gameIds[1]}/abort`, {});
    app.pool.watch();
    series = (await api('GET', '/api/admin/pool')).body.series.find((x: { id: string }) => x.id === r.body.id);
    expect(series.active).toBe(false);
  });

  it('exports a game as JSON and all finished games as CSV', async () => {
    const id = (await api('POST', '/api/games', { settings: { mode: 'export-t', seats: 3, roleCounts: { murderer: 1 } } })).body.id;
    await api('POST', `/api/games/${id}/bots`, { count: 3 });
    await api('POST', `/api/games/${id}/start`, { force: true });
    for (let i = 0; i < 200 && (await api('GET', `/api/games/${id}`)).body.view.phase !== 'ended'; i++) await new Promise((res) => setTimeout(res, 50));
    const json = (await api('GET', `/api/admin/games/${id}/export`)).body;
    expect(json.format).toBe('palermo-game/1');
    expect(json.settings.roleCounts).toEqual({ murderer: 1 });
    expect(json.state.events.length).toBeGreaterThan(5);
    const csv = await (await fetch(`${base}/api/admin/export.csv`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
    const lines = csv.split('\n');
    expect(lines[0]).toContain('game_id,ended_at');
    expect(lines.filter((l) => l.startsWith(id))).toHaveLength(3);
  });
});

