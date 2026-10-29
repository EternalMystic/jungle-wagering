/**
 * Leituras do banco usadas pelos testes de concorrência para conferir o EFEITO (não só
 * o status HTTP). Conexão do pool do teste, fora de qualquer transação da aplicação.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface TxRow {
  id: string;
  kind: string;
  status: string;
  amount: string;
  failure_code: string | null;
  result_balance_amount: string | null;
  idempotency_key: string;
  external_transaction_id: string;
  reference_transaction_id: string | null;
}

export async function transactionsOf(db: Pool, walletId: string): Promise<TxRow[]> {
  const res = await db.query<TxRow>(
    `SELECT id, kind, status, amount, failure_code, result_balance_amount, idempotency_key,
            external_transaction_id, reference_transaction_id
       FROM wager_transactions WHERE wallet_id = $1 ORDER BY created_at, id`,
    [walletId],
  );
  return res.rows;
}

export async function transactionByKey(db: Pool, idempotencyKey: string): Promise<TxRow | undefined> {
  const res = await db.query<TxRow>(
    `SELECT id, kind, status, amount, failure_code, result_balance_amount, idempotency_key,
            external_transaction_id, reference_transaction_id
       FROM wager_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return res.rows[0];
}

export interface LedgerRow {
  transaction_id: string;
  direction: string;
  amount: string;
  balance_after: string;
  wallet_version: number;
}

export async function ledgerOf(db: Pool, walletId: string): Promise<LedgerRow[]> {
  const res = await db.query<LedgerRow>(
    `SELECT transaction_id, direction, amount, balance_after, wallet_version
       FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`,
    [walletId],
  );
  return res.rows;
}

export async function walletState(db: Pool, walletId: string): Promise<{ balance: string; version: number }> {
  const res = await db.query<{ balance_amount: string; version: number }>(
    "SELECT balance_amount, version FROM wallets WHERE id = $1",
    [walletId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`wallet ${walletId} não existe`);
  return { balance: row.balance_amount, version: row.version };
}

/** Tipos de evento na outbox para a transação (convenção de I6/I7: `data.transactionId`). */
export async function outboxEventTypes(db: Pool, transactionId: string): Promise<string[]> {
  const res = await db.query<{ event_type: string }>(
    `SELECT event_type FROM outbox_messages
      WHERE payload -> 'data' ->> 'transactionId' = $1 ORDER BY event_type`,
    [transactionId],
  );
  return res.rows.map((r) => r.event_type);
}

export interface OutboxRow {
  id: string;
  published_at: string | null;
  locked_by: string | null;
}

export async function outboxRows(db: Pool, ids?: readonly string[]): Promise<OutboxRow[]> {
  const res = await db.query<OutboxRow>(
    `SELECT id, published_at::text, locked_by FROM outbox_messages
      WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY occurred_at, id`,
    [ids ?? null],
  );
  return res.rows;
}

export async function inboxRows(db: Pool, messageId: string): Promise<{ consumer_name: string; processed_at: string | null }[]> {
  const res = await db.query<{ consumer_name: string; processed_at: string | null }>(
    "SELECT consumer_name, processed_at::text FROM inbox_messages WHERE message_id = $1",
    [messageId],
  );
  return res.rows;
}

/**
 * Semeia eventos de integração JÁ confirmados na outbox (envelope completo, como
 * `IntegrationEvent.toJSON()`; `eventId` = id da linha), para os testes de publisher
 * terem um backlog antes de qualquer instância subir.
 */
export async function seedOutboxEvents(db: Pool, aggregateId: string, transactionId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  const c: PoolClient = await db.connect();
  try {
    await c.query("BEGIN");
    for (let i = 0; i < count; i++) {
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      const envelope = {
        eventId,
        eventType: "WagerTransactionProcessed",
        aggregateId,
        correlationId: randomUUID(),
        causationId: null,
        occurredAt,
        version: 1,
        data: { transactionId, seq: i },
      };
      await c.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
         VALUES ($1, $2, 'WagerTransactionProcessed', 1, $3, $4)`,
        [eventId, aggregateId, JSON.stringify(envelope), occurredAt],
      );
      ids.push(eventId);
    }
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
  return ids;
}
