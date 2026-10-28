/**
 * Escrita por SQL cru, SEM a aplicação: serve para atacar o schema e provar que a
 * garantia é do banco (§5.9), no mesmo espírito de reference/verify-schema.ts.
 * Linhas "legítimas" forjadas aqui escrevem também a outbox, para que
 * `assertGlobalInvariants` (I6/I7) continue valendo no fim do teste.
 */
import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** Conexão dentro de uma transação aberta pelo teste. */
export type Sql = PoolClient;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface SqlWallet {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
}

/** Abertura legítima: wallet v1 + OPENING PROCESSED + CREDIT v1, num único commit. */
export async function openWalletBySql(
  pool: Pool,
  balance: string,
  options: { currency?: string; playerId?: string } = {},
): Promise<SqlWallet> {
  const currency = options.currency ?? "BRL";
  const walletId = randomUUID();
  const playerId = options.playerId ?? randomUUID();
  await inTransaction(pool, async (c) => {
    await c.query(
      "INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, $3, $4, 1)",
      [walletId, playerId, currency, balance],
    );
    if (balance !== "0.00") {
      const txId = randomUUID();
      await c.query(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            kind, amount, currency, status, result_balance_amount, correlation_id, resolved_at)
         VALUES ($1, 'internal', $2, $3, $4, $5, $6, 'OPENING', $7, $8, 'PROCESSED', $7, $9, now())`,
        [txId, `opening-${walletId}`, `internal:opening-${walletId}`, sha256(walletId), walletId, playerId, balance, currency, randomUUID()],
      );
      await c.query(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
         VALUES ($1, $2, $3, $4, 'CREDIT', $5, 0, $5, 1)`,
        [randomUUID(), walletId, txId, currency, balance],
      );
    }
  });
  return { walletId, playerId, currency };
}

export async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

export interface PgFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

export function asPgFailure(error: unknown): PgFailure {
  if (typeof error !== "object" || error === null) {
    return { code: undefined, constraint: undefined, message: String(error) };
  }
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    constraint: typeof e.constraint === "string" ? e.constraint : undefined,
    message: typeof e.message === "string" ? e.message : String(error),
  };
}

export interface ExpectedRejection {
  readonly code: string;
  /** nome exato da constraint (UNIQUE/FK nomeadas no gabarito) */
  readonly constraint?: string;
  /**
   * Onde a recusa tem de acontecer. `commit` prova que veio de um constraint trigger
   * DIFERIDO (e não de um CHECK imediato qualquer disparado por uma linha forjada mal);
   * `statement` prova que veio de uma constraint imediata.
   */
  readonly at?: "statement" | "commit";
  /**
   * Para CHECK de coluna (nome gerado pelo Postgres): a constraint violada precisa
   * pertencer a `table` e sua definição (`pg_get_constraintdef`) casar com `definition`.
   * Evita passar por acidente com outro 23514.
   */
  readonly check?: { readonly table: string; readonly definition: RegExp };
}

/**
 * Executa `fn` numa transação e exige que ela FALHE com o SQLSTATE `code` — no
 * próprio statement ou no COMMIT (constraint triggers diferidos disparam ali).
 * Se o banco aceitar, o teste falha. Opcionalmente confere a constraint e o momento.
 */
export async function expectRejectedBySchema(
  pool: Pool,
  expected: ExpectedRejection,
  fn: (c: PoolClient) => Promise<unknown>,
): Promise<PgFailure> {
  const c = await pool.connect();
  let failure: PgFailure | undefined;
  let phase: "statement" | "commit" = "statement";
  try {
    await c.query("BEGIN");
    await fn(c);
    phase = "commit";
    await c.query("COMMIT");
  } catch (error) {
    failure = asPgFailure(error);
    await c.query("ROLLBACK").catch(() => undefined);
  } finally {
    c.release();
  }
  if (failure === undefined) {
    throw new Error(`o banco ACEITOU a operação (esperado SQLSTATE ${expected.code})`);
  }
  expect({ code: failure.code, message: failure.message }).toEqual({ code: expected.code, message: failure.message });
  if (expected.constraint !== undefined) expect(failure.constraint).toBe(expected.constraint);
  if (expected.at !== undefined) {
    expect({ at: phase, message: failure.message }).toEqual({ at: expected.at, message: failure.message });
  }
  if (expected.check !== undefined) {
    const res = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = $2::regclass AND contype = 'c'`,
      [failure.constraint ?? "", expected.check.table],
    );
    expect({ constraint: failure.constraint, definition: res.rows[0]?.def ?? null }).toEqual({
      constraint: failure.constraint,
      definition: expect.stringMatching(expected.check.definition),
    });
  }
  return failure;
}

export interface ForgedTx {
  readonly id: string;
  readonly externalId: string;
}

/** INSERT de transação não-OPENING com colunas mínimas; `extra` sobrescreve. */
export async function insertTx(
  c: Sql,
  w: SqlWallet,
  fields: {
    kind: string;
    amount: string;
    status: string;
    externalId?: string;
    idempotencyKey?: string;
    providerId?: string;
    currency?: string;
    failureCode?: string | null;
    resultBalance?: string | null;
    referenceExternalId?: string | null;
    referenceTransactionId?: string | null;
    nextReferenceAttemptAt?: Date | null;
  },
): Promise<ForgedTx> {
  const id = randomUUID();
  const externalId = fields.externalId ?? `ext-${id}`;
  const providerId = fields.providerId ?? "provider-a";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(fields.status);
  await c.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
        status, failure_code, result_balance_amount, correlation_id, next_reference_attempt_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'round-1', 'fortune-chimp', $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, CASE WHEN $18::boolean THEN now() END)`,
    [
      id,
      providerId,
      externalId,
      fields.idempotencyKey ?? `${providerId}:${externalId}`,
      sha256(externalId),
      w.walletId,
      w.playerId,
      fields.kind,
      fields.amount,
      fields.currency ?? w.currency,
      fields.referenceExternalId ?? null,
      fields.referenceTransactionId ?? null,
      fields.status,
      fields.failureCode ?? null,
      fields.resultBalance ?? null,
      randomUUID(),
      fields.nextReferenceAttemptAt ?? null,
      terminal,
    ],
  );
  return { id, externalId };
}

export async function insertLedger(
  c: Sql,
  w: SqlWallet,
  e: { txId: string; direction: "DEBIT" | "CREDIT"; amount: string; before: string; after: string; version: number; currency?: string },
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, w.walletId, e.txId, e.currency ?? w.currency, e.direction, e.amount, e.before, e.after, e.version],
  );
  return id;
}

export async function insertOutbox(c: Sql, aggregateId: string, eventType: string, transactionId: string): Promise<void> {
  await c.query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
     VALUES ($1, $2, $3, 1, $4, now())`,
    [randomUUID(), aggregateId, eventType, JSON.stringify({ eventType, data: { transactionId } })],
  );
}

export async function walletRow(pool: Pool, walletId: string): Promise<{ balance_amount: string; version: number }> {
  const res = await pool.query<{ balance_amount: string; version: number }>(
    "SELECT balance_amount, version FROM wallets WHERE id = $1",
    [walletId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`wallet ${walletId} não existe`);
  return row;
}
