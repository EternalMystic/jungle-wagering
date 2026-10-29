import { describe, expect, test } from "bun:test";
import { decideWager, type DecideWagerInput } from "../../../src/application/wager-rules";
import { BusinessFailureCode as Code } from "../../../src/domain/failure-codes";
import { LedgerDirection } from "../../../src/domain/ledger-entry";
import { Money } from "../../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
} from "../../../src/domain/wager-transaction";
import { Wallet } from "../../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-29T12:00:00.000Z");
const HASH = "b".repeat(64);
const WALLET = "w-1";
const PLAYER = "p-1";

function wallet(balance: string, currency = "BRL"): Wallet {
  return Wallet.rehydrate({
    id: WALLET,
    playerId: PLAYER,
    currency,
    balance: Money.from({ amount: balance, currency }),
    version: 3,
    createdAt: at,
    updatedAt: at,
  });
}

function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: `tx-${overrides.externalTransactionId ?? "1"}`,
    providerId: "provider-a",
    externalTransactionId: "1",
    idempotencyKey: `provider-a:${overrides.externalTransactionId ?? "1"}`,
    payloadHash: HASH,
    walletId: WALLET,
    playerId: PLAYER,
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("80.00"),
    correlationId: "corr",
    createdAt: at,
    ...overrides,
  });
}

/** Referência já resolvida (PROCESSED) — o caminho normal antes de um REFUND/ROLLBACK/WIN. */
function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const t = tx({ externalTransactionId: "ref", ...overrides });
  t.markProcessed({ resultBalance: Money.from({ amount: "20.00", currency: t.money.currency }), at });
  return t;
}

function decide(input: Partial<DecideWagerInput> & Pick<DecideWagerInput, "transaction">) {
  return decideWager({ wallet: wallet("100.00"), reference: undefined, referenceAlreadyReversed: false, ...input });
}

const refundOf = (amount = "80.00") => tx({ externalTransactionId: "r", kind: Kind.Refund, money: brl(amount), referenceExternalTransactionId: "ref" });
const rollbackOf = (amount = "80.00") =>
  tx({ externalTransactionId: "rb", kind: Kind.Rollback, money: brl(amount), referenceExternalTransactionId: "ref" });

describe("BET (§7: débito, rejeitar se saldo insuficiente)", () => {
  test("saldo suficiente → DEBIT", () => {
    expect(decide({ transaction: tx() })).toEqual({ outcome: "APPLY", direction: LedgerDirection.Debit });
  });

  test("saldo exatamente igual ao valor → DEBIT (saldo final 0.00 é válido)", () => {
    expect(decide({ wallet: wallet("80.00"), transaction: tx() })).toEqual({ outcome: "APPLY", direction: LedgerDirection.Debit });
  });

  test("um centavo a menos → REJECT INSUFFICIENT_FUNDS", () => {
    expect(decide({ wallet: wallet("79.99"), transaction: tx() })).toEqual({ outcome: "REJECT", failureCode: Code.InsufficientFunds });
  });
});

describe("pré-condições comuns a todos os kinds", () => {
  test("moeda da operação ≠ moeda da wallet → CURRENCY_MISMATCH (antes de olhar saldo)", () => {
    const usd = tx({ money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(decide({ transaction: usd })).toEqual({ outcome: "REJECT", failureCode: Code.CurrencyMismatch });
  });

  test("player do payload ≠ dono da wallet → WALLET_PLAYER_MISMATCH", () => {
    expect(decide({ transaction: tx({ playerId: "intruder" }) })).toEqual({ outcome: "REJECT", failureCode: Code.WalletPlayerMismatch });
  });
});

describe("WIN (§7: crédito; pode referenciar a BET da mesma rodada — D7)", () => {
  test("sem referência → CREDIT", () => {
    expect(decide({ wallet: wallet("0.00"), transaction: tx({ kind: Kind.Win }) })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Credit,
    });
  });

  test("com referência a uma BET PROCESSED do mesmo escopo → CREDIT ligado à BET", () => {
    const bet = processed();
    const win = tx({ externalTransactionId: "w", kind: Kind.Win, money: brl("200.00"), referenceExternalTransactionId: "ref" });
    expect(decide({ transaction: win, reference: bet })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Credit,
      referenceTransactionId: bet.id,
    });
  });

  test("com referência ausente → aguarda (PENDING_REFERENCE, D8)", () => {
    const win = tx({ externalTransactionId: "w", kind: Kind.Win, referenceExternalTransactionId: "ref" });
    expect(decide({ transaction: win })).toEqual({ outcome: "WAIT_REFERENCE" });
  });

  test("com referência a algo que não é BET → REFERENCE_KIND_NOT_REVERSIBLE", () => {
    const otherWin = processed({ kind: Kind.Win });
    const win = tx({ externalTransactionId: "w", kind: Kind.Win, referenceExternalTransactionId: "ref" });
    expect(decide({ transaction: win, reference: otherWin })).toEqual({ outcome: "REJECT", failureCode: Code.ReferenceKindNotReversible });
  });
});

describe("LOSS (§7: sem efeito no saldo; D7 aceita 0.00)", () => {
  test("registra sem movimento, mesmo com saldo zero", () => {
    expect(decide({ wallet: wallet("0.00"), transaction: tx({ kind: Kind.Loss, money: brl("0.00") }) })).toEqual({ outcome: "RECORD" });
  });

  test("valor maior que o saldo não importa (não debita)", () => {
    expect(decide({ wallet: wallet("1.00"), transaction: tx({ kind: Kind.Loss, money: brl("500.00") }) })).toEqual({ outcome: "RECORD" });
  });
});

describe("REFUND (§7.1–7.5: só BET PROCESSED, mesmo escopo, mesmo valor, uma vez)", () => {
  test("BET PROCESSED do mesmo escopo e valor → CREDIT", () => {
    const bet = processed();
    expect(decide({ transaction: refundOf(), reference: bet })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Credit,
      referenceTransactionId: bet.id,
    });
  });

  test("referência ainda não chegou → WAIT_REFERENCE (D8)", () => {
    expect(decide({ transaction: refundOf() })).toEqual({ outcome: "WAIT_REFERENCE" });
  });

  test("referência a WIN → REFERENCE_KIND_NOT_REVERSIBLE (REFUND só reverte BET)", () => {
    expect(decide({ transaction: refundOf(), reference: processed({ kind: Kind.Win }) })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceKindNotReversible,
    });
  });

  test("valor diferente da BET → REFERENCE_AMOUNT_MISMATCH (sem reversão parcial)", () => {
    expect(decide({ transaction: refundOf("40.00"), reference: processed() })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceAmountMismatch,
    });
  });

  test("BET já revertida (por REFUND ou ROLLBACK, D7) → REFERENCE_ALREADY_REVERSED", () => {
    expect(decide({ transaction: refundOf(), reference: processed(), referenceAlreadyReversed: true })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceAlreadyReversed,
    });
  });

  test("BET REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const rejectedBet = tx({ externalTransactionId: "ref" });
    rejectedBet.reject(Code.InsufficientFunds, { resultBalance: brl("0.00"), at });
    expect(decide({ transaction: refundOf(), reference: rejectedBet })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceNotProcessed,
    });
  });

  test("referência ainda pendente (não terminal) → aguarda, não rejeita", () => {
    const pendingRefund = tx({ externalTransactionId: "ref", kind: Kind.Refund, referenceExternalTransactionId: "older" });
    pendingRefund.markPendingReference(at);
    const rb = rollbackOf();
    expect(decide({ transaction: rb, reference: pendingRefund })).toEqual({ outcome: "WAIT_REFERENCE" });
  });

  test.each([
    ["player", { playerId: "other-player" }],
    ["wallet", { walletId: "other-wallet" }],
    ["rodada", { roundId: "other-round" }],
    ["provider", { providerId: "provider-b" }],
  ] as const)("referência de outro(a) %s → REFERENCE_SCOPE_MISMATCH", (_label, override) => {
    expect(decide({ transaction: refundOf(), reference: processed(override) })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceScopeMismatch,
    });
  });

  test("referência em outra moeda → REFERENCE_SCOPE_MISMATCH", () => {
    const usdBet = processed({ money: Money.from({ amount: "80.00", currency: "USD" }) });
    expect(decide({ transaction: refundOf(), reference: usdBet })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceScopeMismatch,
    });
  });
});

describe("ROLLBACK (§7: inverso da referência, uma vez; §7.9 código distinto)", () => {
  test("de BET → CREDIT", () => {
    const bet = processed();
    expect(decide({ transaction: rollbackOf(), reference: bet })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Credit,
      referenceTransactionId: bet.id,
    });
  });

  test("de WIN → DEBIT", () => {
    const win = processed({ kind: Kind.Win });
    expect(decide({ transaction: rollbackOf(), reference: win })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Debit,
      referenceTransactionId: win.id,
    });
  });

  test("de REFUND → DEBIT", () => {
    const refund = tx({ externalTransactionId: "ref", kind: Kind.Refund, referenceExternalTransactionId: "bet" });
    refund.markProcessed({ resultBalance: brl("100.00"), at, referenceTransactionId: "tx-bet" });
    expect(decide({ transaction: rollbackOf(), reference: refund })).toEqual({
      outcome: "APPLY",
      direction: LedgerDirection.Debit,
      referenceTransactionId: refund.id,
    });
  });

  test("de WIN já gasto (saldo não cobre) → REVERSAL_INSUFFICIENT_FUNDS, distinto de INSUFFICIENT_FUNDS", () => {
    const win = processed({ kind: Kind.Win });
    const decision = decide({ wallet: wallet("79.99"), transaction: rollbackOf(), reference: win });
    expect(decision).toEqual({ outcome: "REJECT", failureCode: Code.ReversalInsufficientFunds });
    expect(Code.ReversalInsufficientFunds).not.toBe(Code.InsufficientFunds);
  });

  test("de LOSS → REFERENCE_KIND_NOT_REVERSIBLE", () => {
    expect(decide({ transaction: rollbackOf(), reference: processed({ kind: Kind.Loss }) })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceKindNotReversible,
    });
  });

  test("valor diferente → REFERENCE_AMOUNT_MISMATCH", () => {
    expect(decide({ transaction: rollbackOf("80.01"), reference: processed() })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceAmountMismatch,
    });
  });

  test("referência já revertida → REFERENCE_ALREADY_REVERSED", () => {
    expect(decide({ transaction: rollbackOf(), reference: processed(), referenceAlreadyReversed: true })).toEqual({
      outcome: "REJECT",
      failureCode: Code.ReferenceAlreadyReversed,
    });
  });
});
