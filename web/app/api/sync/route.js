import { sql } from '@/lib/db';
import { userIdFromBearer } from '@/lib/auth-token';

// Aggregate-only sync payload. No prompt text, transcripts, or file
// contents are ever accepted here — only counts, names, and timestamps.
export async function POST(request) {
  const userId = await userIdFromBearer(request);
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: 'invalid json' }, { status: 400 });

  const db = sql();
  const days = Array.isArray(body.days) ? body.days.slice(0, 31) : [];
  const skillUsage = Array.isArray(body.skillUsage) ? body.skillUsage.slice(0, 200) : [];
  const sessions = Array.isArray(body.sessions) ? body.sessions.slice(0, 100) : [];

  for (const d of days) {
    if (!d.date) continue;
    await db`
      INSERT INTO daily_stats (user_id, date, session_count, project_count, prompts, tool_calls, first_ts, last_ts, projects, skills, synced_at)
      VALUES (${userId}, ${d.date}, ${d.sessionCount || 0}, ${d.projectCount || 0}, ${d.prompts || 0}, ${d.toolCalls || 0},
              ${d.firstTs || null}, ${d.lastTs || null}, ${JSON.stringify(d.projects || [])}, ${JSON.stringify(d.skills || [])}, now())
      ON CONFLICT (user_id, date) DO UPDATE SET
        session_count = EXCLUDED.session_count, project_count = EXCLUDED.project_count,
        prompts = EXCLUDED.prompts, tool_calls = EXCLUDED.tool_calls,
        first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts,
        projects = EXCLUDED.projects, skills = EXCLUDED.skills, synced_at = now()
    `;
  }

  for (const s of skillUsage) {
    if (!s.name) continue;
    await db`
      INSERT INTO skill_usage (user_id, skill_name, uses, last_used, synced_at)
      VALUES (${userId}, ${s.name}, ${s.uses || 0}, ${s.lastUsed || null}, now())
      ON CONFLICT (user_id, skill_name) DO UPDATE SET
        uses = EXCLUDED.uses, last_used = EXCLUDED.last_used, synced_at = now()
    `;
  }

  for (const sess of sessions) {
    if (!sess.id) continue;
    await db`
      INSERT INTO sessions_meta (user_id, session_id, project_name, start_ts, end_ts, user_msgs, tool_calls, synced_at)
      VALUES (${userId}, ${sess.id}, ${sess.projectName || ''}, ${sess.startTs || null}, ${sess.endTs || null},
              ${sess.userMsgs || 0}, ${sess.toolCalls || 0}, now())
      ON CONFLICT (user_id, session_id) DO UPDATE SET
        project_name = EXCLUDED.project_name, start_ts = EXCLUDED.start_ts, end_ts = EXCLUDED.end_ts,
        user_msgs = EXCLUDED.user_msgs, tool_calls = EXCLUDED.tool_calls, synced_at = now()
    `;
  }

  return Response.json({
    ok: true,
    synced: { days: days.length, skills: skillUsage.length, sessions: sessions.length },
    syncedAt: new Date().toISOString(),
  });
}
