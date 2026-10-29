import type { PendingClaim } from "../../application/resolve-pending-references";
import { OutboxMessage } from "../../domain/outbox-message";
import type { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";
import { type OutboxRecord, outboxFromRecord, toDate } from "./records";

export const LEASE_MS = 30_000;
export interface OutboxClaim {
  readonly message: OutboxMessage;
  readonly owner: string;
  readonly until: Date;
}

export class SqlBackgroundStore {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async claimOutbox(owner: string, limit = 50): Promise<OutboxClaim[]> {
    return this.uow.withSql(async (sql) => {
      const { rows } = await sql.query<OutboxRecord & { locked_until: Date | string }>(
        `UPDATE outbox_messages SET locked_by = ?, locked_until = date_trunc('milliseconds', clock_timestamp()) + interval '30 seconds'
          WHERE id IN (SELECT id FROM outbox_messages
            WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
              AND (locked_until IS NULL OR locked_until <= clock_timestamp())
            ORDER BY occurred_at, id LIMIT ? FOR UPDATE SKIP LOCKED)
          RETURNING *`, [owner, limit]);
      return rows.map((r) => ({ message: outboxFromRecord(r), owner, until: toDate(r.locked_until) }));
    });
  }

  async renew(claim: OutboxClaim): Promise<OutboxClaim | undefined> {
    return this.uow.withSql(async (sql) => {
      const { rows } = await sql.query<{ locked_until: Date | string }>(
        `UPDATE outbox_messages SET locked_until = date_trunc('milliseconds', clock_timestamp()) + interval '30 seconds'
         WHERE id = ? AND locked_by = ? AND locked_until = ?
           AND locked_until > clock_timestamp() AND published_at IS NULL RETURNING locked_until`,
        [claim.message.id, claim.owner, claim.until]);
      return rows[0] && { ...claim, until: toDate(rows[0].locked_until) };
    });
  }

  async finish(claim: OutboxClaim, error?: string): Promise<boolean> {
    const message = claim.message;
    const at = new Date();
    if (error === undefined) message.markPublished(at);
    else message.scheduleRetry(at, error);
    return this.uow.withSql(async (sql) => {
      const { rowCount } = await sql.query(
        `UPDATE outbox_messages SET published_at = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
          locked_by = ?, locked_until = ?
         WHERE id = ? AND locked_by = ? AND locked_until = ?
           AND locked_until > clock_timestamp() AND published_at IS NULL`,
        [message.publishedAt ?? null, message.attempts, message.nextAttemptAt, message.lastError ?? null,
          error === undefined ? claim.owner : null, error === undefined ? claim.until : null,
          message.id, claim.owner, claim.until]);
      return rowCount === 1;
    });
  }

  async lagSeconds(): Promise<number> {
    return this.uow.withSql(async (sql) => {
      const { rows } = await sql.query<{ lag: number }>(
        `SELECT COALESCE(GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - min(occurred_at))), 0)::double precision AS lag
         FROM outbox_messages WHERE published_at IS NULL`);
      return rows[0]?.lag ?? 0;
    });
  }

  async claimPending(at: Date, limit = 50): Promise<PendingClaim[]> {
    const until = new Date(at.getTime() + LEASE_MS);
    return this.uow.withSql(async (sql) => {
      const { rows } = await sql.query<{ id: string; wallet_id: string }>(
        `UPDATE wager_transactions SET next_reference_attempt_at = ?
         WHERE id IN (SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
           ORDER BY next_reference_attempt_at, id LIMIT ? FOR UPDATE SKIP LOCKED)
         RETURNING id, wallet_id`, [until, at, limit]);
      return rows.map((r) => ({ transactionId: r.id, walletId: r.wallet_id, claimUntil: until }));
    });
  }
}
