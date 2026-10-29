import {
  IdempotencyRaceLostError,
  LostUpdateError,
  WalletAlreadyExistsError,
} from "../../application/errors";
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/unit-of-work";
import type { InboxMessage } from "../../domain/inbox-message";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/ledger-entry";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import { isUniqueViolation } from "./pg-errors";
import {
  INBOX_COLUMNS,
  type InboxRecord,
  TRANSACTION_SELECT,
  WALLET_COLUMNS,
  type WagerTransactionRecord,
  type WalletRecord,
  inboxFromRecord,
  transactionFromRecord,
  walletFromRecord,
} from "./records";
import type { SqlSession } from "./sql-session";

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly sql: SqlSession) {}

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const { rows } = await this.sql.query<WalletRecord>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
    return rows[0] === undefined ? undefined : walletFromRecord(rows[0]);
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const { rows } = await this.sql.query<WalletRecord>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    return rows[0] === undefined ? undefined : walletFromRecord(rows[0]);
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.sql.query(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, ?, ?::numeric(20,2), ?, ?, ?)`,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toString(), wallet.version, wallet.createdAt, wallet.updatedAt],
      );
    } catch (error) {
      if (isUniqueViolation(error, "uq_wallet_player_currency")) throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      throw error;
    }
  }

  async saveMovement(wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    // condicionado ao estado lido sob o lock: versão e saldo anteriores, e saldo que cobre o débito
    const required = entry.direction === LedgerDirection.Debit ? entry.money.toString() : "0.00";
    const { rowCount } = await this.sql.query(
      `UPDATE wallets
          SET balance_amount = ?::numeric(20,2), version = ?, updated_at = ?
        WHERE id = ? AND version = ? AND balance_amount = ?::numeric(20,2) AND balance_amount >= ?::numeric(20,2)`,
      [
        wallet.balance.toString(),
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        entry.walletVersion - 1,
        entry.balanceBefore.toString(),
        required,
      ],
    );
    if (rowCount !== 1) {
      throw new LostUpdateError(`wallet ${wallet.id}: conditional update from v${entry.walletVersion - 1} matched ${rowCount} rows`);
    }
  }
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly sql: SqlSession) {}

  findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.one(`${TRANSACTION_SELECT} WHERE t.id = ?`, [transactionId]);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one(`${TRANSACTION_SELECT} WHERE t.idempotency_key = ?`, [idempotencyKey]);
  }

  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.one(`${TRANSACTION_SELECT} WHERE t.provider_id = ? AND t.external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
  }

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const { rows } = await this.sql.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
          WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
       ) AS found`,
      [transactionId],
    );
    return rows[0]?.found === true;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    try {
      await this.sql.query(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
           status, failure_code, result_balance_amount, correlation_id, reference_attempts,
           next_reference_attempt_at, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric(20,2), ?, ?, ?, ?, ?, ?::numeric(20,2), ?, ?, ?, ?, ?)`,
        [
          tx.id,
          tx.providerId,
          tx.externalTransactionId,
          tx.idempotencyKey,
          tx.payloadHash,
          tx.walletId,
          tx.playerId,
          tx.roundId ?? null,
          tx.gameId ?? null,
          tx.kind,
          tx.money.toString(),
          tx.money.currency,
          tx.referenceExternalTransactionId ?? null,
          tx.referenceTransactionId ?? null,
          tx.status,
          tx.failureCode ?? null,
          tx.resultBalance?.toString() ?? null,
          tx.correlationId,
          tx.referenceAttempts,
          tx.nextReferenceAttemptAt ?? null,
          tx.createdAt,
          tx.resolvedAt ?? null,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error, "uq_tx_idempotency_key") || isUniqueViolation(error, "uq_tx_provider_external")) {
        throw new IdempotencyRaceLostError(`transaction ${tx.providerId}/${tx.externalTransactionId}: lost the insert race`);
      }
      throw error;
    }
  }

  private async one(sql: string, bindings: readonly string[]): Promise<WagerTransaction | undefined> {
    const { rows } = await this.sql.query<WagerTransactionRecord>(sql, bindings);
    return rows[0] === undefined ? undefined : transactionFromRecord(rows[0]);
  }
}

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly sql: SqlSession) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?::numeric(20,2), ?::numeric(20,2), ?::numeric(20,2), ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.currency,
        entry.direction,
        entry.money.toString(),
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.walletVersion,
        entry.createdAt,
      ],
    );
  }
}

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: SqlSession) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.sql.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        message.eventVersion,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt,
      ],
    );
  }
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly sql: SqlSession) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxMessage | undefined> {
    // ON CONFLICT espera a transação concorrente com a mesma PK: se ela confirmar, é duplicata
    const { rowCount } = await this.sql.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (rowCount === 1) return undefined;
    const { rows } = await this.sql.query<InboxRecord>(
      `SELECT ${INBOX_COLUMNS} FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (rows[0] === undefined) {
      throw new Error(`inbox ${message.consumerName}/${message.messageId}: conflict reported but no committed row`);
    }
    return inboxFromRecord(rows[0]);
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    if (message.processedAt === undefined) throw new Error(`inbox ${message.messageId}: markProcessed before the domain transition`);
    const { rowCount } = await this.sql.query(
      `UPDATE inbox_messages SET processed_at = ?
        WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL`,
      [message.processedAt, message.consumerName, message.messageId],
    );
    if (rowCount !== 1) throw new Error(`inbox ${message.consumerName}/${message.messageId}: mark processed matched ${rowCount} rows`);
  }
}

export function sqlRepositories(sql: SqlSession): TransactionalRepositories {
  return {
    wallets: new SqlWalletRepository(sql),
    transactions: new SqlWagerTransactionRepository(sql),
    ledger: new SqlLedgerRepository(sql),
    outbox: new SqlOutboxRepository(sql),
    inbox: new SqlInboxRepository(sql),
  };
}
