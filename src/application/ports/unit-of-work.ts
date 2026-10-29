import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";

/**
 * Repositórios presos a UMA transação SQL. Só existem dentro de `UnitOfWork.run`;
 * tudo o que é escrito por eles é confirmado junto, ou nada é.
 */
export interface WalletRepository {
  /** `SELECT … FOR UPDATE`: o lock POR WALLET do caminho crítico (D3). */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** Leitura sem lock (consultas). */
  findById(walletId: string): Promise<Wallet | undefined>;
  /** Lança `WalletAlreadyExistsError` se já existe wallet para player+moeda. */
  insert(wallet: Wallet): Promise<void>;
  /**
   * Grava o movimento já aplicado ao agregado com UPDATE CONDICIONADO à versão e ao saldo
   * anteriores (e, no débito, a `balance_amount >= valor`). 0 linhas lança
   * `LostUpdateError`: com o lock tomado isso é erro de programação, nunca caminho normal.
   */
  saveMovement(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND/ROLLBACK PROCESSED apontando para `transactionId` (D7). */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
  /**
   * Lança `IdempotencyRaceLostError` em 23505 de `uq_tx_idempotency_key` ou
   * `uq_tx_provider_external` (outra transação SQL venceu a corrida pela mesma chave).
   */
  insert(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  /** Append-only: não existe update nem delete. */
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}

export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Uma chamada = uma transação SQL curta (BEGIN … COMMIT). Se `work` lança, ROLLBACK.
 * Falhas transitórias de infraestrutura (lock_timeout, conexão) saem como
 * `TransientInfrastructureError`. Nunca fazer I/O de rede dentro de `work`.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
