import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';

/** Shows CHANGELOG.md from the repository: "## version (date)" sections with "- item" lines. */
export function ChangelogPage() {
  const [data, setData] = useState<{ version: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ version: string; text: string }>('GET', '/api/changelog')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  if (!data) return <div className="loading">{error ?? 'Loading…'}</div>;

  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const line of data.text.split(/\r?\n/)) {
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (line.startsWith('## ')) {
      flush();
      blocks.push(<h3 key={`h-${blocks.length}`}>{line.slice(3)}</h3>);
    } else if (line.trim() && !line.startsWith('# ')) {
      flush();
      blocks.push(<p key={`p-${blocks.length}`}>{line}</p>);
    }
  }
  flush();

  return (
    <section className="card changelog">
      <h2>
        Changelog <span className="muted small">current version {data.version}</span>
      </h2>
      {blocks.length ? blocks : <p className="muted">No changelog found.</p>}
    </section>
  );
}
