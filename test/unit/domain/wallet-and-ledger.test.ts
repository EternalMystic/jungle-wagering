import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
  LedgerArithmeticError,
} from "../../../src/domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/domain/ledger-entry";
import { Money } from "../../../src/domain/money";
import { Wallet } from "../../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const at = new Date("2026-10-28T12:00:00.000Z");
const later = new Date("2026-10-28T12:05:00.000Z");

function open(initial: string) {
  return Wallet.open({
    id: "w-1",
    playerId: "p-1",
    initialBalance: brl(initial),
    at,
    openingTransactionId: "tx-open",
    openingEntryId: "le-open",
  });
}

function entry(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return WalletLedgerEntry.create({
    id: "le-1",
    walletId: "w-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("80.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("20.00"),
    walletVersion: 2,
    createdAt: at,
    ...overrides,
  });
}

describe("WalletLedgerEntry — aritmética validada na factory", () => {
  test("lançamento coerente é aceito e balanceado", () => {
    const e = entry();
    expect(e.isBalanced()).toBe(true);
    expect(e.currency).toBe("BRL");
    expect(entry({ direction: LedgerDirection.Credit, balanceAfter: brl("180.00") }).isBalanced()).toBe(true);
  });

  test.each([
    ["DEBIT que não fecha", { balanceAfter: brl("20.01") }],
    ["CREDIT com after de débito", { direction: LedgerDirection.Credit }],
    ["valor zero", { money: brl("0.00"), balanceAfter: brl("100.00") }],
    ["valor negativo", { money: brl("0.00").subtract(brl("1.00")), balanceAfter: brl("101.00") }],
    ["saldo resultante negativo", { balanceBefore: brl("50.00"), balanceAfter: brl("50.00").subtract(brl("80.00")) }],
  ])("rejeita %s", (_label, overrides) => {
    expect(() => entry(overrides)).toThrow(LedgerArithmeticError);
  });

  test("moedas misturadas no lançamento → CurrencyMismatchError", () => {
    expect(() => entry({ balanceBefore: usd("100.00"), balanceAfter: usd("20.00") })).toThrow(CurrencyMismatchError);
  });

  test.each([0, -1, 1.5])("walletVersion inválida %p", (walletVersion) => {
    expect(() => entry({ walletVersion })).toThrow(InvariantViolationError);
  });

  test("imutável estruturalmente: sem setters, objeto congelado", () => {
    const e = entry();
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { balanceAfter: Money }).balanceAfter = brl("999.00");
    }).toThrow();
    expect(e.balanceAfter.toString()).toBe("20.00");
  });

  test("rehydrate reconstrói sem revalidar", () => {
    const e = WalletLedgerEntry.rehydrate({
      id: "le-x",
      walletId: "w-1",
      transactionId: "tx-x",
      direction: LedgerDirection.Debit,
      money: brl("1.00"),
      balanceBefore: brl("5.00"),
      balanceAfter: brl("9.00"),
      walletVersion: 3,
      createdAt: at,
    });
    expect(e.isBalanced()).toBe(false);
  });
});

describe("Wallet.open", () => {
  test("com saldo inicial: version 1 e crédito de abertura v1 a partir de 0.00", () => {
    const { wallet, openingEntry } = open("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry!.balanceAfter.toString()).toBe("100.00");
    expect(openingEntry!.walletVersion).toBe(1);
    expect(openingEntry!.transactionId).toBe("tx-open");
  });

  test("com saldo zero: version 1 e nenhum lançamento", () => {
    const { wallet, openingEntry } = open("0.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("saldo inicial negativo é recusado", () => {
    expect(() =>
      Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("0.00").subtract(brl("1.00")),
        at,
        openingTransactionId: "t",
        openingEntryId: "e",
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe("Wallet — movimentos", () => {
  test("§8: 100.00 − 80.00 = 20.00, version 2, lançamento que explica a mudança", () => {
    const { wallet } = open("100.00");
    const e = wallet.debit({ entryId: "le-1", transactionId: "tx-bet", money: brl("80.00"), at: later });
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(e.balanceBefore.toString()).toBe("100.00");
    expect(e.balanceAfter.toString()).toBe("20.00");
    expect(e.walletVersion).toBe(2);
    expect(e.isBalanced()).toBe(true);
  });

  test("§8: a segunda aposta de 80.00 não cabe → InsufficientFundsError e NADA muda", () => {
    const { wallet } = open("100.00");
    wallet.debit({ entryId: "le-1", transactionId: "tx-1", money: brl("80.00"), at });
    expect(wallet.canDebit(brl("80.00"))).toBe(false);
    expect(() => wallet.debit({ entryId: "le-2", transactionId: "tx-2", money: brl("80.00"), at: later })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(at);
  });

  test("débito exato do saldo leva a 0.00 (permitido)", () => {
    const { wallet } = open("20.00");
    wallet.debit({ entryId: "le-1", transactionId: "tx-1", money: brl("20.00"), at });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("crédito encadeia versões e saldos", () => {
    const { wallet } = open("0.00");
    const e1 = wallet.credit({ entryId: "le-1", transactionId: "tx-1", money: brl("10.00"), at });
    const e2 = wallet.apply(LedgerDirection.Credit, { entryId: "le-2", transactionId: "tx-2", money: brl("0.50"), at });
    expect([e1.walletVersion, e2.walletVersion]).toEqual([2, 3]);
    expect(e2.balanceBefore.equals(e1.balanceAfter)).toBe(true);
    expect(wallet.balance.toString()).toBe("10.50");
  });

  test("moeda da operação ≠ moeda da wallet → CurrencyMismatchError, nada muda", () => {
    const { wallet } = open("100.00");
    expect(() => wallet.credit({ entryId: "e", transactionId: "t", money: usd("1.00"), at })).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("movimento de valor zero é recusado (version só sobe com mudança de saldo)", () => {
    const { wallet } = open("100.00");
    expect(() => wallet.credit({ entryId: "e", transactionId: "t", money: brl("0.00"), at })).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate reconstrói o estado persistido", () => {
    const w = Wallet.rehydrate({
      id: "w-9",
      playerId: "p-9",
      currency: "BRL",
      balance: brl("975.00"),
      version: 7,
      createdAt: at,
      updatedAt: later,
    });
    expect(w.toState()).toEqual({
      id: "w-9",
      playerId: "p-9",
      currency: "BRL",
      balance: brl("975.00"),
      version: 7,
      createdAt: at,
      updatedAt: later,
    });
  });
});
