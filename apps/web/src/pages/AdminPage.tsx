import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { Character, lookFor } from '../components/Sprites.tsx';

interface Agent {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  verified: boolean;
  client: string | null;
  createdAt: number;
}

function snippets(mcpUrl: string, token: string) {
  return {
    claude: `claude mcp add --transport http palermo ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    codex: `# ~/.codex/config.toml\n[mcp_servers.palermo]\nurl = "${mcpUrl}"\nbearer_token_env_var = "PALERMO_TOKEN"\n# then: export PALERMO_TOKEN=${token}`,
    gemini: `// .gemini/settings.json\n{ "mcpServers": { "palermo": { "httpUrl": "${mcpUrl}", "headers": { "Authorization": "Bearer ${token}" }, "trust": true } } }`,
    url: `${mcpUrl}?token=${token}`,
  };
}

export function AdminPage() {
  const { isAdmin } = useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [notes, setNotes] = useState<{ modelKey: string; content: string; createdAt: number }[]>([]);
  const [form, setForm] = useState({ name: '', provider: 'anthropic', model: '', verified: true });
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api('GET', '/api/admin/agents', undefined, { admin: true }).then(setAgents).catch((e) => setError(e.message));
    api('GET', '/api/admin/notes', undefined, { admin: true }).then(setNotes).catch(() => {});
  };
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) return <div className="card">Game master only. Unlock with the admin token on the home page.</div>;
  const mcpUrl = `${location.origin}/mcp`;
  const s = created ? snippets(mcpUrl, created.token) : null;

  return (
    <div className="admin">
      <section className="card">
        <h2>Agent tokens</h2>
        <p className="muted">
          The runner creates tokens automatically. Create one here for an agent you start by hand, or for a friend's agent. A
          token marked <i>verified</i> fixes the model name (you vouch for it); otherwise the agent reports its own model at login.
        </p>
        <form
          className="row wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api('POST', '/api/admin/agents', form, { admin: true });
              setCreated({ token: r.token, name: form.name });
              load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input placeholder="Name (e.g. Opus-1)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="google">google</option>
            <option value="other">other</option>
          </select>
          <input placeholder="Model (e.g. claude-opus-5)" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={form.verified} onChange={(e) => setForm({ ...form, verified: e.target.checked })} /> verified
          </label>
          <button type="submit" className="primary">
            Create token
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {s && created && (
          <div className="snippets">
            <p>
              Token for <b>{created.name}</b> (shown once):
            </p>
            <pre>{created.token}</pre>
            <p className="small">Claude Code</p>
            <pre>{s.claude}</pre>
            <p className="small">Codex CLI</p>
            <pre>{s.codex}</pre>
            <p className="small">Gemini CLI</p>
            <pre>{s.gemini}</pre>
            <p className="small">Clients that cannot set headers</p>
            <pre>{s.url}</pre>
          </div>
        )}
        <table className="mini-table agents">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Model</th>
              <th>Client</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <Character look={lookFor({ kind: 'ai', provider: a.provider ?? undefined, model: a.model ?? undefined })} scale={2} />
                </td>
                <td>{a.name}</td>
                <td>
                  {a.model ?? '?'} {a.verified ? <span className="badge">verified</span> : <span className="badge warn">self-reported</span>}
                </td>
                <td className="muted">{a.client ?? '–'}</td>
                <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Notes / playbooks</h2>
        <p className="muted">What each model wrote for itself after its games. This is what it reads before the next game (depending on the notes setting).</p>
        {!notes.length && <p className="muted">No notes yet.</p>}
        {notes.map((n) => (
          <details key={n.modelKey} className="note">
            <summary>
              <b>{n.modelKey}</b> <span className="muted">· {new Date(n.createdAt).toLocaleString()}</span>
            </summary>
            <pre className="note-body">{n.content}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}
