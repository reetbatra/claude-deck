'use client';
import { useEffect, useState } from 'react';

export default function ConnectPanel() {
  const [tokens, setTokens] = useState([]);
  const [newToken, setNewToken] = useState(null);
  const [loading, setLoading] = useState(false);

  async function loadTokens() {
    const r = await fetch('/api/tokens');
    const j = await r.json();
    setTokens(j.tokens || []);
  }

  useEffect(() => { loadTokens(); }, []);

  async function createToken() {
    setLoading(true);
    const r = await fetch('/api/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'local machine' }),
    });
    const j = await r.json();
    setNewToken(j.token);
    setLoading(false);
    loadTokens();
  }

  async function revoke(id) {
    if (!confirm('Revoke this token? Any machine using it will stop syncing.')) return;
    await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
    loadTokens();
  }

  return (
    <>
      <div className="card">
        <h2>1. Generate a token</h2>
        <button className="btn btn-primary" onClick={createToken} disabled={loading}>
          {loading ? 'Generating…' : '+ New token'}
        </button>
        {newToken && (
          <>
            <p className="section-sub" style={{ marginTop: 14 }}>
              Copy this now — it won&apos;t be shown again.
            </p>
            <div className="token-box">{newToken}</div>
          </>
        )}
      </div>

      <div className="card">
        <h2>2. Run this locally</h2>
        <p className="section-sub">From your claude-deck folder:</p>
        <pre>{`node server.js login ${newToken || '<your-token>'} --api ${
          typeof window !== 'undefined' ? window.location.origin : ''
        }
node server.js sync`}</pre>
        <p className="callout">
          The first command saves the token to <code>data/cloud.json</code> (gitignored).
          The second sends your current daily stats, skill usage, and session
          metadata. Run <code>sync</code> again any time — or use the &quot;Sync now&quot;
          button in the local app&apos;s Today tab.
        </p>
      </div>

      <div className="card">
        <h2>Connected machines</h2>
        {tokens.length === 0 && <p className="callout">No tokens yet.</p>}
        {tokens.map((t) => (
          <div key={t.id} className="session-row" style={{ gridTemplateColumns: '1fr 160px 160px auto' }}>
            <span>{t.label}</span>
            <span className="s-meta">created {new Date(t.created_at).toLocaleDateString()}</span>
            <span className="s-meta">{t.last_used_at ? `last synced ${new Date(t.last_used_at).toLocaleString()}` : 'never synced'}</span>
            <button className="btn" onClick={() => revoke(t.id)}>Revoke</button>
          </div>
        ))}
      </div>
    </>
  );
}
