import { describe, expect, test } from "bun:test";
import { InvalidMessageStateError, InvariantViolationError } from "../../../src/domain/errors";
import {
  type EventContext,
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../src/domain/events";
import { BusinessFailureCode } from "../../../src/domain/failure-codes";
import { InboxMessage } from "../../../src/domain/inbox-message";
import { Money } from "../../../src/domain/money";
import { OUTBOX_BACKOFF_MAX_MS, OutboxMessage, outboxBackoffMs } from "../../../src/domain/outbox-message";
import { WagerTransaction, WagerTransactionKind } from "../../../src/domain/wager-transaction";
import { Wallet } from "../../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-28T12:00:00.000Z");
const HASH = "c".repeat(64);
const ctx: EventContext = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: at };

function bet(kind: WagerTransactionKind = WagerTransactionKind.Bet, extra: { referenceExternalTransactionId?: string } = {}) {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: HASH,
    walletId: "w-1",
    playerId: "p-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("80.00"),
    correlationId: "corr-1",
    createdAt: at,
    ...extra,
  });
}

describe("InboxMessage", () => {
  test("receive → não processada; markProcessed uma única vez", () => {
    const m = InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-consumer", payloadHash: HASH, receivedAt: at });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(at);
    expect(() => m.markProcessed(at)).toThrow(InvalidMessageStateError);
  });

  test("mesmo messageId com hash diferente não é o mesmo payload", () => {
    const m = InboxMessage.receive({ messageId: "msg-1", consumerName: "c", payloadHash: HASH, receivedAt: at });
    expect(m.matchesPayload(HASH)).toBe(true);
    expect(m.matchesPayload("d".repeat(64))).toBe(false);
  });

  test.each([
    { messageId: "", consumerName: "c", payloadHash: HASH },
    { messageId: "m", consumerName: "", payloadHash: HASH },
    { messageId: "m", consumerName: "c", payloadHash: "xyz" },
  ])("receive rejeita %p", (p) => {
    expect(() => InboxMessage.receive({ ...p, receivedAt: at })).toThrow(InvariantViolationError);
  });
});

describe("Eventos de integração", () => {
  test("IntegrationEvent é abstrata: eventType/version vêm da subclasse", () => {
    const tx = bet();
    tx.markProcessed({ resultBalance: brl("20.00"), at });
    const e = WagerTransactionProcessed.from(tx, ctx);
    expect(e).toBeInstanceOf(IntegrationEvent);
    expect(e.eventType).toBe("WagerTransactionProcessed");
    expect(e.version).toBe(1);
  });

  test("WagerTransactionProcessed: envelope JSON estável, dinheiro como string, data ISO", () => {
    const tx = bet();
    tx.markProcessed({ resultBalance: brl("20.00"), at });
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "w-1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-10-28T12:00:00.000Z",
      version: 1,
      data: {
        transactionId: "tx-1",
        walletId: "w-1",
        playerId: "p-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "80.00", currency: "BRL" },
        referenceExternalTransactionId: null,
        status: "PROCESSED",
        referenceTransactionId: null,
        balance: { amount: "20.00", currency: "BRL" },
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("LOSS processada também gera WagerTransactionProcessed", () => {
    const loss = WagerTransaction.create({
      id: "tx-loss",
      providerId: "provider-a",
      externalTransactionId: "ext-loss",
      idempotencyKey: "provider-a:ext-loss",
      payloadHash: HASH,
      walletId: "w-1",
      playerId: "p-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Loss,
      money: brl("0.00"),
      correlationId: "corr-1",
      createdAt: at,
    });
    loss.markProcessed({ resultBalance: brl("100.00"), at });
    expect(WagerTransactionProcessed.from(loss, ctx).data.kind).toBe(WagerTransactionKind.Loss);
  });

  test("WagerTransactionRejected carrega failureCode e saldo observado", () => {
    const tx = bet();
    tx.reject(BusinessFailureCode.InsufficientFunds, { resultBalance: brl("20.00"), at });
    const e = WagerTransactionRejected.from(tx, ctx);
    expect(e.eventType).toBe("WagerTransactionRejected");
    expect(e.data.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(e.data.balance).toEqual({ amount: "20.00", currency: "BRL" });
    expect(e.data.transactionId).toBe("tx-1");
  });

  test("WagerTransactionPendingReference carrega a referência e a próxima tentativa", () => {
    const tx = bet(WagerTransactionKind.Refund, { referenceExternalTransactionId: "ext-bet" });
    tx.markPendingReference(new Date("2026-10-28T12:00:05.000Z"));
    const e = WagerTransactionPendingReference.from(tx, ctx);
    expect(e.data.referenceExternalTransactionId).toBe("ext-bet");
    expect(e.data.nextReferenceAttemptAt).toBe("2026-10-28T12:00:05.000Z");
    expect(e.data.referenceAttempts).toBe(0);
  });

  test("evento exige o status correspondente", () => {
    const pending = bet();
    expect(() => WagerTransactionProcessed.from(pending, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx)).toThrow(InvariantViolationError);
  });

  test("WalletBalanceChanged só a partir do último movimento da própria wallet", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: brl("100.00"),
      at,
      openingTransactionId: "tx-open",
      openingEntryId: "le-open",
    });
    const first = wallet.debit({ entryId: "le-1", transactionId: "tx-1", money: brl("80.00"), at });
    const e = WalletBalanceChanged.from(wallet, first, ctx);
    expect(e.aggregateId).toBe("w-1");
    expect(e.data).toEqual({
      walletId: "w-1",
      transactionId: "tx-1",
      direction: "DEBIT",
      money: { amount: "80.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "20.00", currency: "BRL" },
      walletVersion: 2,
    });
    wallet.credit({ entryId: "le-2", transactionId: "tx-2", money: brl("5.00"), at });
    expect(() => WalletBalanceChanged.from(wallet, first, ctx)).toThrow(InvariantViolationError);
  });

  test("data do evento é imutável", () => {
    const tx = bet();
    tx.markProcessed({ resultBalance: brl("20.00"), at });
    const e = WagerTransactionProcessed.from(tx, ctx);
    expect(Object.isFrozen(e.data)).toBe(true);
    expect(Object.isFrozen(e.data.money)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  function message() {
    const tx = bet();
    tx.markProcessed({ resultBalance: brl("20.00"), at });
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));
  }

  test("enqueue: id = eventId, tipo/versão do evento, payload = envelope, devida já", () => {
    const m = message();
    expect(m.id).toBe("evt-1");
    expect(m.aggregateId).toBe("w-1");
    expect(m.eventType).toBe("WagerTransactionProcessed");
    expect(m.eventVersion).toBe(1);
    expect((m.payload.data as { transactionId: string }).transactionId).toBe("tx-1");
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(at)).toBe(true);
    expect(m.isDue(new Date(at.getTime() - 1))).toBe(false);
  });

  test("scheduleRetry: attempts++ e backoff exponencial 1s, 2s, 4s… com teto de 5 min", () => {
    const m = message();
    const now = new Date("2026-10-28T13:00:00.000Z");
    m.scheduleRetry(now, "throttled");
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt.getTime() - now.getTime()).toBe(1_000);
    expect(m.lastError).toBe("throttled");
    expect(m.isDue(now)).toBe(false);
    m.scheduleRetry(now);
    expect(m.nextAttemptAt.getTime() - now.getTime()).toBe(2_000);
    m.scheduleRetry(now);
    expect(m.nextAttemptAt.getTime() - now.getTime()).toBe(4_000);
    expect([outboxBackoffMs(9), outboxBackoffMs(10), outboxBackoffMs(1_000_000)]).toEqual([
      256_000,
      OUTBOX_BACKOFF_MAX_MS,
      OUTBOX_BACKOFF_MAX_MS,
    ]);
  });

  test("publicado é final: sem republicar e sem reagendar", () => {
    const m = message();
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(at.getTime() + 3_600_000))).toBe(false);
    expect(() => m.markPublished(at)).toThrow(InvalidMessageStateError);
    expect(() => m.scheduleRetry(at)).toThrow(InvalidMessageStateError);
  });
});
