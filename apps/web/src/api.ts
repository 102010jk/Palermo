import { io, type Socket } from 'socket.io-client';

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

export const session = {
  get token() {
    return store.get('palermo.token');
  },
  set token(v: string | null) {
    store.set('palermo.token', v);
  },
  get adminToken() {
    return store.get('palermo.admin');
  },
  set adminToken(v: string | null) {
    store.set('palermo.admin', v);
  },
};

export class ApiError extends Error {}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { admin?: boolean } = {}): Promise<T> {
  const token = opts.admin ? session.adminToken : session.token;
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status}`);
  return data as T;
}

/** Download an admin export (JSON / CSV) as a file. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: session.adminToken ? { authorization: `Bearer ${session.adminToken}` } : {} });
  if (!res.ok) throw new ApiError(`${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

let socket: Socket | null = null;

const credentials = () => ({ token: session.token, adminToken: session.adminToken });

/** One shared socket for the whole app. Listeners survive reconnects. */
export function getSocket(): Socket {
  if (!socket) socket = io({ auth: credentials() });
  return socket;
}

/** Reconnect the same socket with fresh credentials after login/logout (pages re-subscribe on 'connect'). */
export function resetSocket() {
  if (!socket) return;
  const next = credentials();
  const cur = socket.auth as ReturnType<typeof credentials>;
  if (cur.token === next.token && cur.adminToken === next.adminToken) return;
  socket.auth = next;
  socket.disconnect().connect();
}
