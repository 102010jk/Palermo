// stdio <-> Streamable HTTP bridge for the palermo MCP server.
// Claude Code starts this as a local stdio MCP server; the bridge talks HTTP with Node's own fetch.
// This avoids HTTP client differences between CLIs (e.g. "InvalidHTTPResponse" on Windows).
// Usage: node mcp-bridge.mjs <mcpUrl>   (token in env PALERMO_TOKEN)
import { appendFileSync } from 'node:fs';
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
log(`bridge start -> ${url} (node ${process.version}, ${process.platform})`);

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL(url), {
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
