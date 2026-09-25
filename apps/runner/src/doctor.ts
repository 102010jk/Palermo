import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Api } from './api.ts';

/**
 * Connection check without any model: every step prints OK or the exact failure.
 * Run with `npm run runner -- --check` (or doctor.bat).
 */

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.mjs');

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

  await step('6. stdio bridge (how Claude Code connects): initialize + tools/list', async () => {
    const logFile = join(tmpdir(), `palermo-doctor-bridge-${Date.now()}.log`);
    const child = spawn(process.execPath, [BRIDGE, mcpUrl], {
      env: { ...process.env, PALERMO_TOKEN: token, PALERMO_BRIDGE_LOG: logFile },
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
      return `${list.result.tools.length} tools`;
    } catch (e) {
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '(no bridge log)';
      throw new Error(`${describe(e)}\n      bridge log:\n      ${log.split(/\r?\n/).join('\n      ')}`);
    } finally {
      child.kill();
      rmSync(logFile, { force: true });
    }
  });

  console.log('\nSend this whole output (and the server window) if something failed.');
}
