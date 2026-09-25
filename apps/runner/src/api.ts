/** Minimal client for the Palermo REST API. */
export class Api {
  constructor(
    public baseUrl: string,
    private token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async req<T = any>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data?.error ?? text}`);
    return data as T;
  }

  createGame(settings: Record<string, unknown>): Promise<{ id: string }> {
    return this.req('POST', '/api/games', { settings });
  }

  createAgent(a: { name: string; provider?: string; model?: string; verified?: boolean }): Promise<{ token: string; account: { id: string } }> {
    return this.req('POST', '/api/admin/agents', a);
  }

  game(id: string, token?: string): Promise<any> {
    return this.req('GET', `/api/games/${id}`, undefined, token);
  }

  start(id: string, force = false): Promise<unknown> {
    return this.req('POST', `/api/games/${id}/start`, { force });
  }

  addBots(id: string, count: number): Promise<unknown> {
    return this.req('POST', `/api/games/${id}/bots`, { count });
  }

  usage(u: Record<string, unknown>, token?: string): Promise<unknown> {
    return this.req('POST', '/api/usage', u, token);
  }
}
