import { DomainError } from "../domain/errors";
import { BusinessFailureCode, type FailureCode } from "../domain/failure-codes";
import { InboxMessage } from "../domain/inbox-message";
import type { Money } from "../domain/money";
import { payloadHash } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import {
  IdempotencyConflictError,
  IdempotencyRaceLostError,
  InboxPayloadMismatchError,
  InvalidCommandError,
} from "./errors";
import type { Clock } from "./ports/clock";
import { type FaultInjector, FaultPoint, NO_FAULTS } from "./ports/fault-injector";
import type { IdGenerator } from "./ports/id-generator";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work";
import { decideWager } from "./wager-rules";
import { resolveEagerly } from "./resolve-pending-references";
import { settleWager } from "./settle-wager";
export { REFERENCE_FIRST_RETRY_MS } from "./settle-wager";

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

// Replay usa o saldo salvo na decisao. WALLET_NOT_FOUND fica sem transactionId.
export interface WagerResult {
  readonly transactionId: string | undefined;
  readonly status: WagerTransactionStatus;
  readonly balance: Money | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly idempotentReplay: boolean;
}

// No SQS, inbox e efeito ficam no mesmo commit. HTTP nao usa inbox.
export interface QueueDelivery {
  readonly consumerName: string;
  readonly messageId: string;
}

// Apos 23505, tenta reler quem ganhou a corrida de idempotencia.
const MAX_ATTEMPTS = 3;

// Wallet primeiro; inbox, efeito e outbox ficam no mesmo commit.
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly faults: FaultInjector = NO_FAULTS,
  ) {}

  async execute(command: WagerCommand, delivery?: QueueDelivery): Promise<WagerResult> {
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
      if (delivery !== undefined) this.receiveInbox(delivery, hash);
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message);
      throw error;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((repos) =>
          this.attempt(repos, command, hash, build, delivery && this.receiveInbox(delivery, hash)),
        );
      } catch (error) {
        if (error instanceof IdempotencyRaceLostError && attempt < MAX_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private async attempt(
    repos: TransactionalRepositories,
    command: WagerCommand,
    hash: string,
    build: (at: Date) => WagerTransaction,
    inbox: InboxMessage | undefined,
  ): Promise<WagerResult> {
    const { wallets, transactions } = repos;

    // Wallet antes da inbox e das transacoes.
    const wallet = await wallets.lockById(command.walletId);

    if (inbox !== undefined) {
      const previous = await repos.inbox.insertIfAbsent(inbox);
      if (previous !== undefined) {
        if (!previous.matchesPayload(hash)) {
          throw new InboxPayloadMismatchError(
            `message ${inbox.consumerName}/${inbox.messageId} was already received with a different payload`,
          );
        }
        return this.redelivered(repos, command, hash);
      }
    }

    const { result, wrote } = await this.decide(repos, command, hash, build, wallet);
    if (inbox !== undefined) {
      inbox.markProcessed(this.clock.now());
      await repos.inbox.markProcessed(inbox);
    }
    if (wrote) this.faults.checkpoint(FaultPoint.BeforeCommit);
    return result;
  }

    // Busca por provider + external id: a key nao entra no hash.
  // Sem original, foi WALLET_NOT_FOUND. Nao reprocessar se a wallet apareceu depois.
  private async redelivered(repos: TransactionalRepositories, command: WagerCommand, hash: string): Promise<WagerResult> {
    const original = await repos.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId);
    if (original?.matchesPayload(hash)) return resultOf(original, true);
    return { ...walletNotFound(), idempotentReplay: true };
  }

  private async decide(
    repos: TransactionalRepositories,
    command: WagerCommand,
    hash: string,
    build: (at: Date) => WagerTransaction,
    wallet: Wallet | undefined,
  ): Promise<{ result: WagerResult; wrote: boolean }> {
    const { transactions } = repos;

    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing !== undefined) {
      if (!existing.matchesPayload(hash)) {
        throw new IdempotencyConflictError(`Idempotency-Key ${command.idempotencyKey} was already used with a different payload`);
      }
      return { result: resultOf(existing, true), wrote: false };
    }

    const sameOperation = await transactions.findByProviderExternalId(command.providerId, command.externalTransactionId);
    if (sameOperation !== undefined) {
      throw new IdempotencyConflictError(
        `transaction ${command.providerId}/${command.externalTransactionId} was already submitted with another Idempotency-Key`,
      );
    }

    if (wallet === undefined) return { result: walletNotFound(), wrote: false };

    const at = this.clock.now();
    const tx = build(at);
    const reference =
      tx.referenceExternalTransactionId === undefined
        ? undefined
        : await transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
    const wasReversed =
      reference !== undefined && tx.requiresReference() ? await transactions.hasProcessedReversal(reference.id) : false;
    const decision = decideWager({ wallet, transaction: tx, reference, referenceAlreadyReversed: wasReversed });

    await settleWager(repos, wallet, tx, decision, at, this.ids);
    const result = resultOf(tx, false);
    if (tx.isTerminal()) await resolveEagerly(repos, wallet, tx, at, this.ids);
    return { result, wrote: true };
  }

  private receiveInbox(delivery: QueueDelivery, hash: string): InboxMessage {
    return InboxMessage.receive({
      consumerName: delivery.consumerName,
      messageId: delivery.messageId,
      payloadHash: hash,
      receivedAt: this.clock.now(),
    });
  }
}

function walletNotFound(): WagerResult {
  return {
    transactionId: undefined,
    status: WagerTransactionStatus.Rejected,
    balance: undefined,
    failureCode: BusinessFailureCode.WalletNotFound,
    idempotentReplay: false,
  };
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
