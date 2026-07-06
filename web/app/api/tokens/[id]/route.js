import { auth } from '@clerk/nextjs/server';
import { sql } from '@/lib/db';

export async function DELETE(request, { params }) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const db = sql();
  await db`DELETE FROM api_tokens WHERE id = ${id} AND user_id = ${userId}`;
  return Response.json({ ok: true });
}
