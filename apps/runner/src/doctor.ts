import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Api } from './api.ts';
import { localPipeFor } from './pipe.ts';
import { cliOutput } from './proc.ts';

/**
 * Connection check without any model: every step prints OK or the exact failure.
 * Run with `npm run runner -- --check` (or doctor.bat).
 */

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.mjs');

async function cliVersion(cmd: string): Promise<string | null> {
  const out = await cliOutput(cmd, ['--version']);
  return out !== null ? out.split(/\r?\n/)[0] || 'installed' : null;
}

function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const c = err?.cause;
  return `${err?.message ?? String(e)}${c ? ` (cause: ${c.code ?? ''} ${c.message ?? ''})` : ''}`;
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t = Date.now();
  try {
    const detail = await fn();
    console.log(`\x1b[32mOK  \x1b[0m ${name} (${Date.now() - t} ms)${detail ? `\n      ${detail}` : ''}`);
    return true;
  } catch (e) {
    console.log(`\x1b[31mFAIL\x1b[0m ${name} (${Date.now() - t} ms)\n      ${describe(e)}`);
    return false;
  }
}

export async function doctor(server: string, api: Api): Promise<void> {
  const base = server.replace(/\/$/, '');
  const mcpUrl = `${base}/mcp`;
  console.log(`Palermo doctor – node ${process.version} on ${process.platform}, server ${base}\n`);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (process.env[k] ?? process.env[k.toLowerCase()]) console.log(`note: ${k}=${process.env[k] ?? process.env[k.toLowerCase()]}`);
  }

  for (const cli of ['claude', 'codex', 'agy', 'gemini']) {
    const v = await cliVersion(cli);
    console.log(`${v ? '\x1b[32mOK  \x1b[0m' : '\x1b[33m--  \x1b[0m'} ${cli} CLI: ${v ?? 'not found (only needed if a player uses it)'}`);
    if (v && cli === 'agy') {
      const models = await cliOutput('agy', ['models']);
      if (models) console.log(`      agy models (use one of these names in the config):\n      ${models.split(/\r?\n/).join('\n      ')}`);
    }
  }

  await step('1. server health (GET /api/health)', async () => {
    const r = await fetch(`${base}/api/health`);
    return `HTTP ${r.status} ${await r.text()}`;
  });

  let token = '';
  const ok = await step('2. create a test agent token (admin API)', async () => {
    const a = await api.createAgent({ name: `doctor-${Date.now() % 10000}`, provider: 'test', model: 'doctor', verified: true });
    token = a.token;
    return '';
  });
  if (!ok) return;

  await step('3. raw MCP initialize (POST /mcp with fetch)', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } },
      }),
    });
    const headers = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join(' | ');
    const body = await r.text();
    return `HTTP ${r.status} | ${headers}\n      body: ${body.slice(0, 300)}`;
  });

  await step('4. raw server/discover probe (what new Claude Code sends first)', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'server/discover', params: {} }),
    });
    return `HTTP ${r.status} body: ${(await r.text()).slice(0, 200)}`;
  });

  await step('5. MCP SDK client: connect + login tool', async () => {
    const client = new Client({ name: 'palermo-doctor', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const r = (await client.callTool({ name: 'login', arguments: { model: 'doctor' } })) as { content: { text?: string }[] };
    await client.close();
    return (r.content[0]?.text ?? '').split('\n')[0];
  });

  await bridgeStep('6. stdio bridge over TCP: initialize + tools/list', mcpUrl, token, process.env, false);
  const pipe = localPipeFor(mcpUrl);
  if (pipe) {
    await bridgeStep(`6b. stdio bridge over the local pipe ${pipe}`, mcpUrl, token, { ...process.env, PALERMO_SOCKET: pipe }, false);
  }
  // Claude Code starts MCP servers with a reduced environment; mimic that and hold a long-poll open.
  const game = await api.createGame({ mode: 'doctor' }).catch(() => null);
  if (game) {
    await bridgeStep(
      '7. bridge as Claude Code starts it (minimal environment, pipe) + a 3 s wait_for_events',
      mcpUrl,
      token,
      { ...minimalEnv(), ...(pipe ? { PALERMO_SOCKET: pipe } : {}) },
      game.id,
    );
    await api.req('POST', `/api/games/${game.id}/abort`, {}).catch(() => {});
  }

  console.log('\nSend this whole output (and the server window) if something failed.');
}

/** The environment MCP clients typically pass to stdio servers (see the MCP SDK's getDefaultEnvironment). */
function minimalEnv(): NodeJS.ProcessEnv {
  const keys =
    process.platform === 'win32'
      ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) {
    const hit = Object.keys(process.env).find((x) => x.toUpperCase() === k);
    if (hit) env[hit] = process.env[hit];
  }
  return env;
}

async function bridgeStep(name: string, mcpUrl: string, token: string, baseEnv: NodeJS.ProcessEnv, longPollGame: string | false) {
  await step(name, async () => {
    const logFile = join(tmpdir(), `palermo-doctor-bridge-${Date.now()}.log`);
    const child = spawn(process.execPath, [BRIDGE, mcpUrl], {
      env: { ...baseEnv, PALERMO_TOKEN: token, PALERMO_BRIDGE_LOG: logFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (id: number, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = lines.find((l) => l.includes(`"id":${id}`));
        if (hit) return JSON.parse(hit);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no answer from the bridge within ${ms} ms`);
    };
    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'doctor-stdio', version: '1' } },
      });
      const init = await waitFor(1);
      if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const list = await waitFor(2);
      if (list.error) throw new Error(`tools/list error: ${JSON.stringify(list.error)}`);
      const via = () => (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('[pipe]') ? 'local pipe' : 'TCP');
      if (!longPollGame) return `${list.result.tools.length} tools via ${via()}`;
      const call = async (id: number, name: string, args: Record<string, unknown>) => {
        send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
        const r = await waitFor(id, 20000);
        if (r.error) throw new Error(`${name} error: ${JSON.stringify(r.error)}`);
        return String(r.result?.content?.[0]?.text ?? '');
      };
      await call(3, 'login', { model: 'doctor' });
      await call(5, 'join_game', { game_id: longPollGame });
      const t = Date.now();
      const waited = await call(4, 'wait_for_events', { max_wait_seconds: 3 });
      return `long-poll via ${via()} returned after ${Date.now() - t} ms: ${waited.split('\n')[0].slice(0, 80)}`;
    } catch (e) {
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '(no bridge log)';
      throw new Error(`${describe(e)}\n      bridge log:\n      ${log.split(/\r?\n/).join('\n      ')}`);
    } finally {
      child.kill();
      rmSync(logFile, { force: true });
    }
  });
}
