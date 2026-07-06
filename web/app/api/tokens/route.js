import { auth } from '@clerk/nextjs/server';
import { sql } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/tokens';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const db = sql();
  const rows = await db`
    SELECT id, label, created_at, last_used_at FROM api_tokens
    WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
  return Response.json({ tokens: rows });
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || 'local machine').slice(0, 80);

  const token = generateToken();
  const hash = hashToken(token);
  const db = sql();
  const rows = await db`
    INSERT INTO api_tokens (user_id, token_hash, label)
    VALUES (${userId}, ${hash}, ${label})
    RETURNING id, label, created_at
  `;
  return Response.json({ token, ...rows[0] });
}
