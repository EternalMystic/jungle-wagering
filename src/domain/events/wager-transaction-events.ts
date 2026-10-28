import { InvariantViolationError } from "../errors";
import type { BusinessFailureCode } from "../failure-codes";
import type { MoneyProps } from "../money";
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from "../wager-transaction";
import { type EventContext, IntegrationEvent } from "./integration-event";

/** Campos comuns aos eventos de transação. Ausentes são `null` (schema JSON estável). */
export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly status: WagerTransactionStatus;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  readonly referenceTransactionId: string | null;
  /** saldo da wallet após a transação (o mesmo devolvido no replay) */
  readonly balance: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: BusinessFailureCode;
  /** saldo observado sob o lock no momento da rejeição */
  readonly balance: MoneyProps;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  readonly referenceAttempts: number;
  /** ISO-8601 */
  readonly nextReferenceAttemptAt: string;
}

function common(tx: WagerTransaction, expected: WagerTransactionStatus, eventType: string): WagerTransactionEventData {
  if (tx.status !== expected) {
    throw new InvariantViolationError(`${eventType} requires a ${expected} transaction, ${tx.id} is ${tx.status}`);
  }
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    status: tx.status,
  };
}

/**
 * Eventos de transação têm a WALLET como agregado (aggregateId = walletId): todos os
 * eventos de uma wallet caem no mesmo MessageGroupId e chegam ordenados ao consumidor (D18).
 */

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const base = common(tx, WagerTransactionStatus.Processed, "WagerTransactionProcessed");
    const balance = tx.resultBalance;
    if (balance === undefined) throw new InvariantViolationError(`processed transaction ${tx.id} has no resultBalance`);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base, referenceTransactionId: tx.referenceTransactionId ?? null, balance: balance.toJSON() },
    });
  }
}

/** Rejeição por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const base = common(tx, WagerTransactionStatus.Rejected, "WagerTransactionRejected");
    const balance = tx.resultBalance;
    const failureCode = tx.failureCode;
    if (balance === undefined || failureCode === undefined) {
      throw new InvariantViolationError(`rejected transaction ${tx.id} lacks failureCode/resultBalance`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base, failureCode: failureCode as BusinessFailureCode, balance: balance.toJSON() },
    });
  }
}

/** A referência ainda não chegou; o worker tentará de novo em `nextReferenceAttemptAt`. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const base = common(tx, WagerTransactionStatus.PendingReference, "WagerTransactionPendingReference");
    const next = tx.nextReferenceAttemptAt;
    if (next === undefined) throw new InvariantViolationError(`pending transaction ${tx.id} has no next attempt`);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base, referenceAttempts: tx.referenceAttempts, nextReferenceAttemptAt: next.toISOString() },
    });
  }
}
