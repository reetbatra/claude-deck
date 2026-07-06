import { neon } from '@neondatabase/serverless';

// Lazy singleton — avoids crashing `next build` when DATABASE_URL isn't
// set yet (e.g. first deploy before the Neon integration finishes wiring
// env vars). Do NOT wrap this in a Proxy: Clerk/Neon internals do property
// checks that a Proxy silently breaks.
let _sql = null;
export function sql() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}
