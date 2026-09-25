// stdio <-> Streamable HTTP bridge for the palermo MCP server.
// Claude Code starts this as a local stdio MCP server; the bridge talks HTTP to the game server.
// HTTP goes through plain node:http (no fetch/undici, no proxy, a fresh connection per request), because
// on some Windows setups every other HTTP client path returned corrupted responses.
// Usage: node mcp-bridge.mjs <mcpUrl>   (token in env PALERMO_TOKEN, optional log file in PALERMO_BRIDGE_LOG)
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2];
const token = process.env.PALERMO_TOKEN;
if (!url || !token) {
  console.error('usage: PALERMO_TOKEN=... node mcp-bridge.mjs <mcpUrl>');
  process.exit(2);
}

const logFile = process.env.PALERMO_BRIDGE_LOG;
const log = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.error(text);
  if (logFile) {
    try {
      appendFileSync(logFile, `${text}\n`);
    } catch {}
  }
};
const describe = (e) => {
  const c = e?.cause;
  return `${e?.message ?? e}${c ? ` (cause: ${c.code ?? ''} ${c.message ?? c})` : ''}`;
};
const proxyVars = Object.keys(process.env).filter((k) => /proxy/i.test(k));
log(
  `bridge start -> ${url} (node ${process.version}, ${process.platform}; proxy env: ${proxyVars.map((k) => `${k}=${process.env[k]}`).join(' ') || 'none'})`,
);

const NULL_BODY = new Set([101, 204, 205, 304]);
// Local IPC path of the game server (named pipe on Windows). Preferred when present; TCP is the fallback.
let socketPath = process.env.PALERMO_SOCKET || null;
if (socketPath) log(`using local pipe ${socketPath} (TCP fallback: ${url})`);

/** Minimal fetch() on top of node:http. Supports what the MCP client transport needs, incl. streamed SSE bodies. */
function httpFetch(input, init = {}) {
  if (!socketPath) return httpFetchOnce(input, init, null);
  return httpFetchOnce(input, init, socketPath).catch((e) => {
    if (!['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM'].includes(e?.code)) throw e;
    log(`local pipe unavailable (${e.code}); switching to TCP ${url}`);
    socketPath = null;
    return httpFetchOnce(input, init, null);
  });
}

function httpFetchOnce(input, init, viaSocket) {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = {};
  new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
  const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  headers.connection = 'close';
  const method = init.method ?? 'GET';
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const options = viaSocket
      ? { socketPath: viaSocket, path: `${target.pathname}${target.search}`, method, headers: { ...headers, host: target.host }, agent: false }
      : { method, headers, agent: false };
    const onResponse = (res) => {
      const status = res.statusCode ?? 0;
      log(`${method} ${target.pathname} ${viaSocket ? '[pipe]' : '[tcp]'} -> ${status} ${res.headers['content-type'] ?? ''} (${Date.now() - started} ms)`);
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
      }
      if (NULL_BODY.has(status) || method === 'HEAD') {
        res.resume();
        resolve(new Response(null, { status, headers: h }));
      } else {
        resolve(new Response(Readable.toWeb(res), { status, headers: h }));
      }
    };
    const req = viaSocket ? http.request(options, onResponse) : lib.request(target, options, onResponse);
    req.on('error', (e) => {
      log(`${method} ${target.pathname} failed after ${Date.now() - started} ms: ${describe(e)}`);
      reject(e);
    });
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error('aborted'));
      else init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end(body);
  });
}

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL(url), {
  fetch: httpFetch,
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

local.onmessage = (msg) =>
  remote.send(msg).catch((e) => {
    log(`request ${msg.method ?? '(response)'} failed: ${describe(e)}`);
    if (msg.id !== undefined) {
      local.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Palermo server unreachable: ${e.message}` } });
    }
  });
remote.onmessage = (msg) => local.send(msg);
remote.onerror = (e) => log(`transport error: ${describe(e)}`);
local.onclose = () => remote.close().finally(() => process.exit(0));

await remote.start();
await local.start();
