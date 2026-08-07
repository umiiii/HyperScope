import { ensureSchema, getDatabasePool } from "@/lib/db";

export type OutboxNotification = {
  id: string;
  title: string;
  body: string;
  targetUrl: string;
  tag: string;
  attempts: number;
};

export async function claimNextNotification(): Promise<OutboxNotification | null> {
  await ensureSchema();
  const pool = getDatabasePool();
  await pool.query(`
    UPDATE notification_outbox
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes'
  `);

  const result = await pool.query<{
    id: string;
    title: string;
    body: string;
    target_url: string;
    tag: string;
    attempts: number;
  }>(`
    WITH candidate AS (
      SELECT id
      FROM notification_outbox
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE notification_outbox outbox
    SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
    FROM candidate
    WHERE outbox.id = candidate.id
    RETURNING outbox.id, outbox.title, outbox.body, outbox.target_url,
      outbox.tag, outbox.attempts
  `);

  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        title: row.title,
        body: row.body,
        targetUrl: row.target_url,
        tag: row.tag,
        attempts: row.attempts,
      }
    : null;
}

export async function markNotificationSent(id: string) {
  await getDatabasePool().query(
    `
      UPDATE notification_outbox
      SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = $1
    `,
    [id],
  );
}

export async function retryNotification(id: string, error: string, attempts: number) {
  const delaySeconds = Math.min(900, 30 * 2 ** Math.min(attempts, 5));
  await getDatabasePool().query(
    `
      UPDATE notification_outbox
      SET status = 'pending', last_error = $2,
        next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'), updated_at = NOW()
      WHERE id = $1
    `,
    [id, error.slice(0, 500), delaySeconds],
  );
}
