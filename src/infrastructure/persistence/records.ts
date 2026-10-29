import { isFailureCode } from "../../domain/failure-codes";
import { InboxMessage } from "../../domain/inbox-message";
import { Money } from "../../domain/money";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";

/**
 * Registros = linhas como o driver as devolve e mappers que reconstroem o domínio SEMPRE
 * por `rehydrate` (não revalida transições). Dinheiro nunca passa por number: a string do
 * NUMERIC(20,2) vai direto para `Money.from`. O knex/pg configurado pelo MikroORM devolve
 * TIMESTAMPTZ como string — datas e inteiros são normalizados aqui, na fronteira.
 */
type DbTimestamp = Date | string;
type DbInteger = number | string;

/** Saída textual do Postgres para TIMESTAMPTZ: `2026-10-29 21:21:20.93+00` (fração e minutos do offset opcionais). */
const PG_TIMESTAMPTZ = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::?(\d{2}))?$/;

function toDate(value: DbTimestamp): Date {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else {
    const m = PG_TIMESTAMPTZ.exec(value);
    if (m === null) throw new Error(`unexpected timestamp format from database: ${value}`);
    const [, day, time, fraction = "", offsetHours, offsetMinutes = "00"] = m;
    // ISO-8601 estrito (ms com 3 dígitos; microssegundos do Postgres truncados)
    date = new Date(`${day}T${time}.${fraction.padEnd(3, "0").slice(0, 3)}${offsetHours}:${offsetMinutes}`);
  }
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp from database: ${String(value)}`);
  return date;
}

function toOptionalDate(value: DbTimestamp | null): Date | undefined {
  return value === null ? undefined : toDate(value);
}

function toInteger(value: DbInteger): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`invalid integer from database: ${String(value)}`);
  return n;
}

export interface WalletRecord {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance_amount: string;
  readonly version: DbInteger;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
}

export const WALLET_COLUMNS = "id, player_id, currency, balance_amount, version, created_at, updated_at";

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.from({ amount: r.balance_amount, currency: r.currency }),
    version: toInteger(r.version),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  });
}

export interface WagerTransactionRecord {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly wallet_id: string;
  readonly player_id: string;
  readonly round_id: string | null;
  readonly game_id: string | null;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly status: string;
  readonly failure_code: string | null;
  readonly result_balance_amount: string | null;
  readonly correlation_id: string;
  readonly reference_attempts: DbInteger;
  readonly next_reference_attempt_at: DbTimestamp | null;
  readonly created_at: DbTimestamp;
  readonly resolved_at: DbTimestamp | null;
  /** moeda da WALLET: o saldo observado é dela (difere da transação em CURRENCY_MISMATCH) */
  readonly wallet_currency: string;
}

/** SELECT da transação com a moeda da wallet (para reidratar `resultBalance`). */
export const TRANSACTION_SELECT = `
  SELECT t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash,
         t.wallet_id, t.player_id, t.round_id, t.game_id, t.kind, t.amount, t.currency,
         t.reference_external_transaction_id, t.reference_transaction_id, t.status, t.failure_code,
         t.result_balance_amount, t.correlation_id, t.reference_attempts, t.next_reference_attempt_at,
         t.created_at, t.resolved_at, w.currency AS wallet_currency
    FROM wager_transactions t
    JOIN wallets w ON w.id = t.wallet_id`;

const KINDS: readonly string[] = Object.values(WagerTransactionKind);
const STATUSES: readonly string[] = Object.values(WagerTransactionStatus);

function isKind(value: string): value is WagerTransactionKind {
  return KINDS.includes(value);
}
function isStatus(value: string): value is WagerTransactionStatus {
  return STATUSES.includes(value);
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  if (!isKind(r.kind)) throw new Error(`wager_transactions ${r.id}: unknown kind ${r.kind}`);
  if (!isStatus(r.status)) throw new Error(`wager_transactions ${r.id}: unknown status ${r.status}`);
  const failureCode = r.failure_code ?? undefined;
  if (failureCode !== undefined && !isFailureCode(failureCode)) {
    throw new Error(`wager_transactions ${r.id}: unknown failure_code ${failureCode}`);
  }
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id ?? undefined,
    gameId: r.game_id ?? undefined,
    kind: r.kind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    status: r.status,
    failureCode,
    resultBalance:
      r.result_balance_amount === null ? undefined : Money.from({ amount: r.result_balance_amount, currency: r.wallet_currency }),
    correlationId: r.correlation_id,
    referenceAttempts: toInteger(r.reference_attempts),
    nextReferenceAttemptAt: toOptionalDate(r.next_reference_attempt_at),
    createdAt: toDate(r.created_at),
    resolvedAt: toOptionalDate(r.resolved_at),
  });
}

export interface InboxRecord {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: DbTimestamp;
  processed_at: DbTimestamp | null;
}

export const INBOX_COLUMNS = "consumer_name, message_id, payload_hash, received_at, processed_at";

export function inboxFromRecord(r: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: r.consumer_name,
    messageId: r.message_id,
    payloadHash: r.payload_hash,
    receivedAt: toDate(r.received_at),
    processedAt: toOptionalDate(r.processed_at),
  });
}
