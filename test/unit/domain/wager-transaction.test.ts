import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidTransactionStateError, InvariantViolationError } from "../../../src/domain/errors";
import { BusinessFailureCode, InfraFailureCode } from "../../../src/domain/failure-codes";
import { LedgerDirection } from "../../../src/domain/ledger-entry";
import { Money } from "../../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-28T12:00:00.000Z");
const HASH = "a".repeat(64);

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: HASH,
    walletId: "w-1",
    playerId: "p-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("25.00"),
    correlationId: "corr-1",
    createdAt: at,
    ...overrides,
  };
}

const create = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));
const refund = () => create({ id: "tx-r", kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" });

/** Uma transação em cada estado terminal, alcançado por transições legítimas. */
function terminals(): [string, WagerTransaction][] {
  const processed = create();
  processed.markProcessed({ resultBalance: brl("75.00"), at });
  const rejected = create();
  rejected.reject(BusinessFailureCode.InsufficientFunds, { resultBalance: brl("20.00"), at });
  const failed = create();
  failed.fail(InfraFailureCode.PermanentInfraError, at);
  return [
    ["PROCESSED", processed],
    ["REJECTED", rejected],
    ["FAILED", failed],
  ];
}

describe("WagerTransaction.create", () => {
  test("nasce PENDING, sem resultado, sem resolução", () => {
    const tx = create();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.resolvedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test("OPENING não pode ser submetido (interno)", () => {
    expect(() => create({ kind: Kind.Opening })).toThrow(InvariantViolationError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referenceExternalTransactionId", (kind) => {
    expect(() => create({ kind })).toThrow(InvariantViolationError);
    expect(create({ kind, referenceExternalTransactionId: "ext-0" }).requiresReference()).toBe(true);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])("%s exige valor > 0", (kind) => {
    expect(() => create({ kind, money: brl("0.00"), referenceExternalTransactionId: "ext-0" })).toThrow(
      InvariantViolationError,
    );
  });

  test("LOSS aceita 0.00 e não afeta saldo", () => {
    const loss = create({ kind: Kind.Loss, money: brl("0.00") });
    expect(loss.affectsBalance()).toBe(false);
    expect(create().affectsBalance()).toBe(true);
  });

  test.each([
    ["providerId vazio", { providerId: "" }],
    ["providerId > 128", { providerId: "p".repeat(129) }],
    ["externalTransactionId vazio", { externalTransactionId: "" }],
    ["idempotencyKey > 512", { idempotencyKey: "k".repeat(513) }],
    ["roundId vazio", { roundId: "" }],
    ["gameId vazio", { gameId: "" }],
    ["payloadHash maiúsculo", { payloadHash: "A".repeat(64) }],
    ["payloadHash curto", { payloadHash: "a".repeat(63) }],
    ["referência vazia", { referenceExternalTransactionId: "" }],
    ["correlationId vazio", { correlationId: "" }],
  ])("rejeita %s", (_label, overrides) => {
    expect(() => create(overrides)).toThrow(InvariantViolationError);
  });

  test("matchesPayload compara o hash", () => {
    expect(create().matchesPayload(HASH)).toBe(true);
    expect(create().matchesPayload("b".repeat(64))).toBe(false);
  });
});

describe("WagerTransaction.createOpening", () => {
  test("OPENING interno: provider 'internal', sem rodada/jogo/referência", () => {
    const tx = WagerTransaction.createOpening({
      id: "tx-open",
      walletId: "w-1",
      playerId: "p-1",
      money: brl("100.00"),
      payloadHash: HASH,
      correlationId: "corr",
      createdAt: at,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe("internal");
    expect(tx.roundId).toBeUndefined();
    expect(tx.gameId).toBeUndefined();
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("WagerTransaction — transições", () => {
  test("PENDING → PROCESSED congela o saldo observado", () => {
    const tx = create();
    tx.markProcessed({ resultBalance: brl("75.00"), at });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.resultBalance!.toString()).toBe("75.00");
    expect(tx.resolvedAt).toEqual(at);
  });

  test("PENDING → REJECTED guarda failureCode e saldo observado", () => {
    const tx = create({ money: brl("80.00") });
    tx.reject(BusinessFailureCode.InsufficientFunds, { resultBalance: brl("20.00"), at });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(tx.resultBalance!.toString()).toBe("20.00");
  });

  test("REJECTED por CURRENCY_MISMATCH guarda o saldo na moeda da wallet", () => {
    const tx = create({ money: Money.from({ amount: "10.00", currency: "USD" }) });
    tx.reject(BusinessFailureCode.CurrencyMismatch, { resultBalance: brl("100.00"), at });
    expect(tx.resultBalance!.currency).toBe("BRL");
  });

  test("PROCESSED exige saldo na moeda da transação", () => {
    const tx = create({ money: Money.from({ amount: "10.00", currency: "USD" }) });
    expect(() => tx.markProcessed({ resultBalance: brl("1.00"), at })).toThrow(CurrencyMismatchError);
    expect(tx.status).toBe(Status.Pending);
  });

  test("WALLET_NOT_FOUND nunca vira transação persistida (D6)", () => {
    expect(() => create().reject(BusinessFailureCode.WalletNotFound, { resultBalance: brl("0.00"), at })).toThrow(
      InvariantViolationError,
    );
  });

  test("reject só aceita código de negócio; fail só aceita código de infra", () => {
    const tx = create();
    expect(() => tx.reject("PERMANENT_INFRA_ERROR" as BusinessFailureCode, { resultBalance: brl("1.00"), at })).toThrow(
      InvariantViolationError,
    );
    expect(() => tx.fail("INSUFFICIENT_FUNDS" as InfraFailureCode, at)).toThrow(InvariantViolationError);
    expect(tx.status).toBe(Status.Pending);
  });

  test("PENDING → FAILED (terminal, sem saldo de resultado)", () => {
    const tx = create();
    tx.fail(InfraFailureCode.PermanentInfraError, at);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe("PERMANENT_INFRA_ERROR");
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.resolvedAt).toEqual(at);
  });

  test("REFUND: PENDING → PENDING_REFERENCE → (retry) → PROCESSED ligado à referência", () => {
    const tx = refund();
    const t1 = new Date("2026-10-28T12:00:05.000Z");
    const t2 = new Date("2026-10-28T12:00:15.000Z");
    tx.markPendingReference(t1);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceAttemptAt).toEqual(t1);
    tx.scheduleReferenceRetry(t2);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(t2);
    expect(() => tx.markProcessed({ resultBalance: brl("125.00"), at })).toThrow(InvariantViolationError);
    tx.markProcessed({ resultBalance: brl("125.00"), at, referenceTransactionId: "tx-bet" });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("tx-bet");
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test("PENDING_REFERENCE → REJECTED REFERENCE_NOT_FOUND (limite esgotado)", () => {
    const tx = refund();
    tx.markPendingReference(at);
    tx.reject(BusinessFailureCode.ReferenceNotFound, { resultBalance: brl("100.00"), at });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test("transação sem referência não pode aguardar referência", () => {
    expect(() => create().markPendingReference(at)).toThrow(InvariantViolationError);
  });

  test("scheduleReferenceRetry só a partir de PENDING_REFERENCE; markPendingReference só de PENDING", () => {
    expect(() => refund().scheduleReferenceRetry(at)).toThrow(InvalidTransactionStateError);
    const tx = refund();
    tx.markPendingReference(at);
    expect(() => tx.markPendingReference(at)).toThrow(InvalidTransactionStateError);
  });

  test("transação não pode referenciar a si mesma", () => {
    const tx = refund();
    expect(() => tx.markProcessed({ resultBalance: brl("1.00"), at, referenceTransactionId: "tx-r" })).toThrow(
      InvariantViolationError,
    );
  });

  test.each(terminals())("%s é terminal: toda transição lança InvalidTransactionStateError e nada muda", (_label, tx) => {
    const before = tx.toState();
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed({ resultBalance: brl("1.00"), at })).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(BusinessFailureCode.InsufficientFunds, { resultBalance: brl("1.00"), at })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(InfraFailureCode.PermanentInfraError, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.scheduleReferenceRetry(at)).toThrow(InvalidTransactionStateError);
    expect(tx.toState()).toEqual(before);
  });

  test("rehydrate não revalida transições (reconstrói estado já persistido)", () => {
    const state = { ...create().toState(), status: Status.Processed, resultBalance: brl("1.00"), resolvedAt: at };
    const tx = WagerTransaction.rehydrate(state);
    expect(tx.toState()).toEqual(state);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  const ref = (kind: Kind) => create({ id: `ref-${kind}`, kind, referenceExternalTransactionId: "ext-0" });

  test("BET debita; WIN e REFUND creditam", () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a referência: BET → CREDIT; WIN/REFUND → DEBIT", () => {
    const rb = create({ kind: Kind.Rollback, referenceExternalTransactionId: "ext-0" });
    expect(rb.ledgerDirectionFor(ref(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(ref(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(ref(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  test("ROLLBACK sem referência, de LOSS ou de ROLLBACK é erro; LOSS não lança", () => {
    const rb = create({ kind: Kind.Rollback, referenceExternalTransactionId: "ext-0" });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => rb.ledgerDirectionFor(ref(Kind.Loss))).toThrow(InvariantViolationError);
    expect(() => rb.ledgerDirectionFor(ref(Kind.Rollback))).toThrow(InvariantViolationError);
    expect(() => create({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });
});
