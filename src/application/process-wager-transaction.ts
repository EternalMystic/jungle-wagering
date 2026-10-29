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

/**
 * De onde veio o comando quando a entrada é a fila (§10). Com ela, o use case grava a inbox
 * `(consumerName, messageId)` na MESMA transação do efeito; sem ela (HTTP), não há inbox.
 */
export interface QueueDelivery {
  readonly consumerName: string;
  readonly messageId: string;
}

/** Nova leitura após perder a corrida de um 23505 (D4): 1 basta; 3 é folga, não laço. */
const MAX_ATTEMPTS = 3;

/**
 * Caminho crítico (CLAUDE.md, "Contrato transacional"): uma transação SQL curta por tentativa —
 *   1. `SELECT … FOR UPDATE` na wallet (lock POR WALLET; wallets diferentes seguem em paralelo);
 *   2. inbox (só SQS): `INSERT … ON CONFLICT DO NOTHING`; já existia → replay (mesmo hash) ou
 *      veneno (`InboxPayloadMismatchError`); a linha é marcada processada no mesmo commit;
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
        return await this.uow.run((repositories) =>
          this.attempt(repositories, command, hash, build, delivery && this.receiveInbox(delivery, hash)),
        );
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
    inbox: InboxMessage | undefined,
  ): Promise<WagerResult> {
    const { wallets, transactions } = repositories;

    // 1. lock POR WALLET — antes de qualquer leitura/escrita de inbox ou transação
    //    (ordem wallet → demais linhas)
    const wallet = await wallets.lockById(command.walletId);

    // 2. inbox: redelivery de mensagem já confirmada não decide nada de novo
    if (inbox !== undefined) {
      const previous = await repositories.inbox.insertIfAbsent(inbox);
      if (previous !== undefined) {
        if (!previous.matchesPayload(hash)) {
          throw new InboxPayloadMismatchError(
            `message ${inbox.consumerName}/${inbox.messageId} was already received with a different payload`,
          );
        }
        return this.redelivered(repositories, command, hash);
      }
    }

    const { result, wrote } = await this.decide(repositories, command, hash, build, wallet);
    if (inbox !== undefined) {
      inbox.markProcessed(this.clock.now());
      await repositories.inbox.markProcessed(inbox);
    }
    if (wrote) this.faults.checkpoint(FaultPoint.BeforeCommit);
    return result;
  }

  /**
   * A inbox diz que esta mensagem já foi confirmada (inbox e efeito saem no mesmo commit):
   * devolve o resultado ORIGINAL sem decidir de novo. O original é achado pela identidade de
   * negócio `(provider, external)` com o mesmo hash (a key não entra no hash, D4). Sem ele, o
   * original foi a única rejeição não persistida (WALLET_NOT_FOUND, D6) — e continua sendo, mesmo
   * que a wallet tenha sido criada depois: mensagem tratada não é reprocessada.
   */
  private async redelivered(repositories: TransactionalRepositories, command: WagerCommand, hash: string): Promise<WagerResult> {
    const original = await repositories.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId);
    if (original?.matchesPayload(hash)) return resultOf(original, true);
    return { ...walletNotFound(), idempotentReplay: true };
  }

  private async decide(
    repositories: TransactionalRepositories,
    command: WagerCommand,
    hash: string,
    build: (at: Date) => WagerTransaction,
    wallet: Wallet | undefined,
  ): Promise<{ result: WagerResult; wrote: boolean }> {
    const { transactions } = repositories;

    // 3. idempotência persistente
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

    await settleWager(repositories, wallet, tx, decision, at, this.ids);
    const result = resultOf(tx, false);
    if (tx.isTerminal()) await resolveEagerly(repositories, wallet, tx, at, this.ids);
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
