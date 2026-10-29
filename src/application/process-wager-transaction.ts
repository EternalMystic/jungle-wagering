import { DomainError } from "../domain/errors";
import type { IntegrationEvent } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/events/wager-transaction-events";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { BusinessFailureCode, type FailureCode } from "../domain/failure-codes";
import type { Money } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { payloadHash } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { IdempotencyConflictError, IdempotencyRaceLostError, InvalidCommandError } from "./errors";
import type { Clock } from "./ports/clock";
import type { IdGenerator } from "./ports/id-generator";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work";
import { decideWager } from "./wager-rules";

/** O que o provedor submete — igual por HTTP e por SQS (§10: mesmo use case). */
export interface WagerCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
}

/**
 * Resultado (o mesmo no replay, §7.7). `balance` é o saldo observado sob o lock no momento
 * da decisão, congelado em `result_balance_amount`. Sem `transactionId` só em WALLET_NOT_FOUND,
 * a única rejeição não persistida (D6).
 */
export interface WagerResult {
  readonly transactionId: string | undefined;
  readonly status: WagerTransactionStatus;
  readonly balance: Money | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly idempotentReplay: boolean;
}

/** Primeira nova tentativa de resolver uma referência ausente (D8: 5 s · 2^n, teto 5 min). */
export const REFERENCE_FIRST_RETRY_MS = 5_000;

/** Nova leitura após perder a corrida de um 23505 (D4): 1 basta; 3 é folga, não laço. */
const MAX_ATTEMPTS = 3;

/**
 * Caminho crítico (CLAUDE.md, "Contrato transacional"): uma transação SQL curta por tentativa —
 *   1. `SELECT … FOR UPDATE` na wallet (lock POR WALLET; wallets diferentes seguem em paralelo);
 *   2. (inbox — entra com o consumidor SQS);
 *   3. busca por `idempotency_key`: mesmo hash → replay do resultado ORIGINAL; outro → conflito;
 *      mesmo (provider, external) com outra key → conflito;
 *   4. decisão no domínio; INSERT da transação; UPDATE condicionado da wallet; INSERT do ledger;
 *   5. INSERT na outbox (eventos do mesmo commit);
 *   6. COMMIT — só então a resposta sai.
 * 23505 numa chave de idempotência (corrida com uma transação de OUTRA wallet) ⇒ ROLLBACK e
 * releitura, que vira replay ou conflito.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: WagerCommand): Promise<WagerResult> {
    if (command.kind === WagerTransactionKind.Opening) {
      throw new InvalidCommandError("OPENING is internal and cannot be submitted");
    }
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
    const transactionId = this.ids.next();
    const build = (at: Date): WagerTransaction =>
      WagerTransaction.create({
        id: transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        correlationId: command.correlationId,
        createdAt: at,
      });
    // valida o comando ANTES de abrir transação: entrada inválida nunca toma lock
    try {
      build(this.clock.now());
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message);
      throw error;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((repositories) => this.attempt(repositories, command, hash, build));
      } catch (error) {
        if (error instanceof IdempotencyRaceLostError && attempt < MAX_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private async attempt(
    repositories: TransactionalRepositories,
    command: WagerCommand,
    hash: string,
    build: (at: Date) => WagerTransaction,
  ): Promise<WagerResult> {
    const { wallets, transactions, ledger, outbox } = repositories;

    // 1. lock POR WALLET — antes de qualquer leitura de transação (ordem wallet → transações)
    const wallet = await wallets.lockById(command.walletId);

    // 3. idempotência persistente
    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing !== undefined) {
      if (!existing.matchesPayload(hash)) {
        throw new IdempotencyConflictError(`Idempotency-Key ${command.idempotencyKey} was already used with a different payload`);
      }
      return resultOf(existing, true);
    }
    const sameOperation = await transactions.findByProviderExternalId(command.providerId, command.externalTransactionId);
    if (sameOperation !== undefined) {
      throw new IdempotencyConflictError(
        `transaction ${command.providerId}/${command.externalTransactionId} was already submitted with another Idempotency-Key`,
      );
    }

    if (wallet === undefined) {
      return {
        transactionId: undefined,
        status: WagerTransactionStatus.Rejected,
        balance: undefined,
        failureCode: BusinessFailureCode.WalletNotFound,
        idempotentReplay: false,
      };
    }

    // 4. decisão de negócio sob o lock
    const at = this.clock.now();
    const tx = build(at);
    const reference =
      tx.referenceExternalTransactionId === undefined
        ? undefined
        : await transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== undefined && tx.requiresReference() ? await transactions.hasProcessedReversal(reference.id) : false;
    const decision = decideWager({ wallet, transaction: tx, reference, referenceAlreadyReversed });

    const ctx = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
    const events: IntegrationEvent<unknown>[] = [];
    switch (decision.outcome) {
      case "APPLY": {
        const entry = wallet.apply(decision.direction, { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at });
        tx.markProcessed({ resultBalance: wallet.balance, at, referenceTransactionId: decision.referenceTransactionId });
        await transactions.insert(tx);
        await wallets.saveMovement(wallet, entry);
        await ledger.append(entry);
        events.push(WagerTransactionProcessed.from(tx, ctx()), WalletBalanceChanged.from(wallet, entry, ctx()));
        break;
      }
      case "RECORD":
        tx.markProcessed({ resultBalance: wallet.balance, at, referenceTransactionId: decision.referenceTransactionId });
        await transactions.insert(tx);
        events.push(WagerTransactionProcessed.from(tx, ctx()));
        break;
      case "REJECT":
        tx.reject(decision.failureCode, { resultBalance: wallet.balance, at });
        await transactions.insert(tx);
        events.push(WagerTransactionRejected.from(tx, ctx()));
        break;
      case "WAIT_REFERENCE":
        tx.markPendingReference(new Date(at.getTime() + REFERENCE_FIRST_RETRY_MS));
        await transactions.insert(tx);
        events.push(WagerTransactionPendingReference.from(tx, ctx()));
        break;
    }

    // 5. outbox no mesmo commit
    for (const event of events) await outbox.add(OutboxMessage.enqueue(event));
    return resultOf(tx, false);
  }
}

function resultOf(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance,
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}
