import { InvalidTransactionStateError, InvariantViolationError } from "./errors";
import {
  BusinessFailureCode,
  type FailureCode,
  type InfraFailureCode,
  isBusinessFailureCode,
  isInfraFailureCode,
} from "./failure-codes";
import { LedgerDirection } from "./ledger-entry";
import type { Money } from "./money";

/**
 * Objetos `const` + união de literais (não `enum` do TS, que é nominal): o valor do
 * contrato/banco ("BET", "PROCESSED") é o próprio tipo, sem cast nas fronteiras de I/O.
 */
export const WagerTransactionKind = {
  /** interno: crédito de abertura da wallet; nunca vem da API nem da fila */
  Opening: "OPENING",
  Bet: "BET",
  Win: "WIN",
  Loss: "LOSS",
  Refund: "REFUND",
  Rollback: "ROLLBACK",
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: "PENDING",
  PendingReference: "PENDING_REFERENCE",
  Processed: "PROCESSED",
  Rejected: "REJECTED",
  Failed: "FAILED",
} as const;
export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

const KINDS: readonly string[] = Object.values(WagerTransactionKind);

const TERMINAL: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/**
 * Transições válidas (mesma tabela do trigger `fn_tx_guard`):
 *   PENDING           → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED → (terminais; qualquer transição é erro de programação)
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVERSAL_KINDS: readonly WagerTransactionKind[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

/** O que o provedor submete (HTTP ou SQS). `OPENING` não é aceito aqui. */
export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly payloadHash: string;
  readonly correlationId: string;
  readonly createdAt: Date;
}

/** Estado persistido; `rehydrate` o reconstrói sem revalidar transições. */
export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly referenceTransactionId: string | undefined;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | undefined;
  readonly resultBalance: Money | undefined;
  readonly correlationId: string;
  readonly referenceAttempts: number;
  readonly nextReferenceAttemptAt: Date | undefined;
  readonly createdAt: Date;
  readonly resolvedAt: Date | undefined;
}

export const OPENING_PROVIDER_ID = "internal";

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
    private _resolvedAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida campos e a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvariantViolationError("OPENING is internal and cannot be submitted");
    }
    if (!KINDS.includes(props.kind)) {
      throw new InvariantViolationError(`unknown transaction kind ${String(props.kind)}`);
    }
    requireText("providerId", props.providerId, 128);
    requireText("externalTransactionId", props.externalTransactionId, 256);
    requireText("roundId", props.roundId);
    requireText("gameId", props.gameId);
    const reference = props.referenceExternalTransactionId;
    if (REVERSAL_KINDS.includes(props.kind) && reference === undefined) {
      throw new InvariantViolationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined) requireText("referenceExternalTransactionId", reference, 256);
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvariantViolationError(`${props.kind} amount must be ${props.kind === WagerTransactionKind.Loss ? ">= 0" : "> 0"}`);
    }
    return WagerTransaction.pending({ ...props, referenceExternalTransactionId: reference });
  }

  /** Crédito de abertura (interno, `OPENING`): sem rodada, jogo ou referência. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) throw new InvariantViolationError("OPENING amount must be > 0");
    return WagerTransaction.pending({
      ...props,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: `opening-${props.walletId}`,
      idempotencyKey: `${OPENING_PROVIDER_ID}:opening-${props.walletId}`,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      referenceExternalTransactionId: undefined,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
      state.resolvedAt,
    );
  }

  private static pending(p: {
    readonly id: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly walletId: string;
    readonly playerId: string;
    readonly roundId: string | undefined;
    readonly gameId: string | undefined;
    readonly kind: WagerTransactionKind;
    readonly money: Money;
    readonly referenceExternalTransactionId: string | undefined;
    readonly correlationId: string;
    readonly createdAt: Date;
  }): WagerTransaction {
    requireText("id", p.id);
    requireText("idempotencyKey", p.idempotencyKey, 512);
    requireText("walletId", p.walletId);
    requireText("playerId", p.playerId);
    requireText("correlationId", p.correlationId);
    if (!PAYLOAD_HASH_PATTERN.test(p.payloadHash)) {
      throw new InvariantViolationError("payloadHash must be 64 lowercase hex chars (SHA-256)");
    }
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.correlationId,
      p.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  /** Saldo observado sob o lock no momento da decisão; congelado para o replay (§7.7). */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get resolvedAt(): Date | undefined {
    return this._resolvedAt;
  }

  // ---- transições

  /**
   * Aplicada. `resultBalance` é o saldo da wallet depois do efeito (ou o atual, para LOSS).
   * REFUND/ROLLBACK exigem a referência interna resolvida.
   */
  markProcessed(props: { readonly resultBalance: Money; readonly at: Date; readonly referenceTransactionId?: string }): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    this.money.assertSameCurrency(props.resultBalance);
    if (props.resultBalance.isNegative()) throw new InvariantViolationError("resultBalance cannot be negative");
    const ref = props.referenceTransactionId;
    if (this.requiresReference() && ref === undefined) {
      throw new InvariantViolationError(`${this.kind} cannot be processed without referenceTransactionId`);
    }
    if (ref !== undefined && this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError("referenceTransactionId given for a transaction without reference");
    }
    if (ref === this.id) throw new InvariantViolationError("a transaction cannot reference itself");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = ref;
    this._resultBalance = props.resultBalance;
    this._nextReferenceAttemptAt = undefined;
    this._resolvedAt = props.at;
  }

  /** Referência ainda não chegou: primeira vez em PENDING_REFERENCE. */
  markPendingReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference requires PENDING, transaction ${this.id} is ${this._status}`);
    }
    this.assertWaitsForReference();
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** Nova tentativa de resolução sem sucesso: conta a tentativa e reagenda. */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry requires PENDING_REFERENCE, transaction ${this.id} is ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /**
   * Rejeição de negócio (terminal). `resultBalance` = saldo observado sob o lock, na moeda
   * da wallet (pode diferir da moeda da transação em CURRENCY_MISMATCH).
   * WALLET_NOT_FOUND não é persistível (D6) e por isso não é aceito aqui.
   */
  reject(code: BusinessFailureCode, props: { readonly resultBalance: Money; readonly at: Date }): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    if (!isBusinessFailureCode(code)) throw new InvariantViolationError(`${String(code)} is not a business failure code`);
    if (code === BusinessFailureCode.WalletNotFound) {
      throw new InvariantViolationError("WALLET_NOT_FOUND is never persisted as a transaction (D6)");
    }
    if (props.resultBalance.isNegative()) throw new InvariantViolationError("resultBalance cannot be negative");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = props.resultBalance;
    this._nextReferenceAttemptAt = undefined;
    this._resolvedAt = props.at;
  }

  /** Erro permanente de infraestrutura (terminal, auditável). */
  fail(code: InfraFailureCode, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    if (!isInfraFailureCode(code)) throw new InvariantViolationError(`${String(code)} is not an infrastructure failure code`);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._resolvedAt = at;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento: BET → DEBIT; WIN/REFUND/OPENING → CREDIT;
   * ROLLBACK → inverso da referência (BET → CREDIT; WIN/REFUND → DEBIT). LOSS não lança.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError("LOSS does not produce a ledger entry");
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) throw new InvariantViolationError("ROLLBACK direction needs the referenced transaction");
        if (reference.kind === WagerTransactionKind.Bet) return LedgerDirection.Credit;
        if (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new InvariantViolationError(`ROLLBACK cannot reverse ${reference.kind}`);
      }
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      referenceTransactionId: this._referenceTransactionId,
      status: this._status,
      failureCode: this._failureCode,
      resultBalance: this._resultBalance,
      correlationId: this.correlationId,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
      createdAt: this.createdAt,
      resolvedAt: this._resolvedAt,
    };
  }

  private assertCanMoveTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`invalid transition ${this._status} -> ${next} for transaction ${this.id}`);
    }
  }

  private assertWaitsForReference(): void {
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError(`${this.kind} without reference cannot wait for one`);
    }
  }
}

function requireText(field: string, value: unknown, maxLength?: number): void {
  if (typeof value !== "string" || value.length === 0 || (maxLength !== undefined && value.length > maxLength)) {
    throw new InvariantViolationError(`${field} must be a non-empty string${maxLength ? ` of at most ${maxLength} chars` : ""}`);
  }
}
