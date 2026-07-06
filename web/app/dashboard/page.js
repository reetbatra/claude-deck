import { auth } from '@clerk/nextjs/server';
import { sql } from '@/lib/db';
import Topbar from '../components/Topbar';

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
}

export default async function DashboardPage() {
  const { userId } = await auth();
  const db = sql();

  const days = await db`
    SELECT * FROM daily_stats WHERE user_id = ${userId}
    ORDER BY date DESC LIMIT 14
  `;
  const skills = await db`
    SELECT skill_name, uses, last_used FROM skill_usage
    WHERE user_id = ${userId} AND uses > 0 ORDER BY uses DESC LIMIT 10
  `;
  const sessions = await db`
    SELECT session_id, project_name, start_ts, end_ts, user_msgs, tool_calls FROM sessions_meta
    WHERE user_id = ${userId} ORDER BY start_ts DESC LIMIT 30
  `;

  const today = days[0];
  const chartDays = [...days].reverse();
  const maxCount = Math.max(1, ...chartDays.map((d) => d.session_count));
  const maxSkill = Math.max(1, ...skills.map((s) => s.uses));

  const hasAnyData = days.length > 0;

  return (
    <>
      <Topbar />
      <div className="wrap">
        <h1>Your dashboard</h1>

        {!hasAnyData && (
          <div className="card">
            <p className="callout">
              No data synced yet. Head to <a href="/connect" style={{ color: 'var(--accent)', fontWeight: 600 }}>Connect</a> to
              generate a token and run the sync command locally.
            </p>
          </div>
        )}

        {hasAnyData && (
          <>
            <div className="stat-row">
              <div className="stat-tile"><div className="stat-value">{today?.session_count ?? 0}</div><div className="stat-label">Sessions today</div></div>
              <div className="stat-tile"><div className="stat-value">{today?.project_count ?? 0}</div><div className="stat-label">Projects touched</div></div>
              <div className="stat-tile"><div className="stat-value">{today?.prompts ?? 0}</div><div className="stat-label">Requests made</div></div>
              <div className="stat-tile"><div className="stat-value">{today?.tool_calls ?? 0}</div><div className="stat-label">Actions taken</div></div>
            </div>

            <div className="card">
              <h2>Activity — last {chartDays.length} synced days</h2>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 100, paddingTop: 8 }}>
                {chartDays.map((d) => {
                  const h = d.session_count === 0 ? 2 : Math.max(6, Math.round((d.session_count / maxCount) * 80));
                  return (
                    <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
                         title={`${new Date(d.date).toLocaleDateString()} — ${d.session_count} sessions`}>
                      <div style={{ width: '100%', maxWidth: 28, height: h, background: 'var(--series)', borderRadius: '4px 4px 0 0' }} />
                      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{fmtDate(d.date)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h2>Skill usage</h2>
              {skills.length === 0 && <p className="callout">No skill invocations synced yet.</p>}
              {skills.map((s) => (
                <div key={s.skill_name} className="usage-row">
                  <span style={{ fontWeight: 600 }}>/{s.skill_name}</span>
                  <span className="usage-bar-track"><span className="usage-bar-fill" style={{ width: `${Math.round(s.uses / maxSkill * 100)}%` }} /></span>
                  <span className="u-count">{s.uses}×</span>
                </div>
              ))}
            </div>

            <div className="card">
              <h2>Recent sessions</h2>
              {sessions.map((s) => (
                <div key={s.session_id} className="session-row">
                  <span className="s-meta">{fmtDate(s.start_ts)} {fmtTime(s.start_ts)}</span>
                  <span className="s-project">{s.project_name}</span>
                  <span className="s-meta">{s.user_msgs} prompts · {s.tool_calls} actions</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
