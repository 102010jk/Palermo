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
    manager: { botDelayMs: [5, 20], tickMs: 50 },
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

    const stats = computeStats(app.db);
    expect(stats.games).toBe(1);
    expect(stats.byModel.find((b) => b.key === 'test:Opus-model')?.games).toBe(1);
    const filtered = computeStats(app.db, { settings: { identityVisibility: 'anonymous' } });
    expect(filtered.games).toBe(0);
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
});
