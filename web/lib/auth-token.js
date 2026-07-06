import { sql } from './db';
import { hashToken } from './tokens';

export async function userIdFromBearer(request) {
  const authHeader = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!m) return null;
  const hash = hashToken(m[1].trim());
  const db = sql();
  const rows = await db`SELECT user_id FROM api_tokens WHERE token_hash = ${hash}`;
  if (!rows.length) return null;
  await db`UPDATE api_tokens SET last_used_at = now() WHERE token_hash = ${hash}`;
  return rows[0].user_id;
}
