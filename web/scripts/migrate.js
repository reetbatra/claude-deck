// One-time schema setup. Run with: npx dotenv -e .env.local -- node scripts/migrate.js
const { neon } = require('@neondatabase/serverless');

async function main() {
  const sql = neon(process.env.DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT 'local machine',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS daily_stats (
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      session_count INT NOT NULL DEFAULT 0,
      project_count INT NOT NULL DEFAULT 0,
      prompts INT NOT NULL DEFAULT 0,
      tool_calls INT NOT NULL DEFAULT 0,
      first_ts TIMESTAMPTZ,
      last_ts TIMESTAMPTZ,
      projects JSONB NOT NULL DEFAULT '[]',
      skills JSONB NOT NULL DEFAULT '[]',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, date)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS skill_usage (
      user_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      uses INT NOT NULL DEFAULT 0,
      last_used TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, skill_name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions_meta (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      start_ts TIMESTAMPTZ,
      end_ts TIMESTAMPTZ,
      user_msgs INT NOT NULL DEFAULT 0,
      tool_calls INT NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, session_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date ON daily_stats (user_id, date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_meta_user_start ON sessions_meta (user_id, start_ts DESC)`;

  console.log('Migration complete: api_tokens, daily_stats, skill_usage, sessions_meta');
}

main().catch((e) => { console.error(e); process.exit(1); });
