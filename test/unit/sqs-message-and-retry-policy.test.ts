/**
 * Unidade da borda SQS: parsing do envelope §10 (veneno → motivo estável) e a classificação
 * D9 negócio/transitório/permanente + backoff. O comportamento contra a fila REAL está em
 * test/integration/sqs-consumer.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidCommandError,
  LostUpdateError,
  TransientInfrastructureError,
} from "../../src/application/errors";
import { classifyFailure, retryDelaySeconds } from "../../src/interface/sqs/retry-policy";
import { PoisonMessageError, parseWagerMessage } from "../../src/interface/sqs/wager-message";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

function envelope(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: "provider-a:transaction-123",
      playerId: PLAYER,
      walletId: WALLET,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...data,
    },
    ...overrides,
  };
}

const gen = () => "generated-id";

function reasonOf(body: string | undefined): string {
  try {
    parseWagerMessage(body, gen);
  } catch (error) {
    if (error instanceof PoisonMessageError) return error.reason;
    throw error;
  }
  throw new Error("esperava PoisonMessageError");
}

describe("parseWagerMessage (§10)", () => {
  test("mensagem do enunciado → mesmo comando do HTTP, key de data.idempotencyKey", () => {
    const { messageId, command } = parseWagerMessage(JSON.stringify(envelope()), gen);
    expect(messageId).toBe("msg-123");
    expect(command).toMatchObject({
      idempotencyKey: "provider-a:transaction-123",
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      walletId: WALLET,
      playerId: PLAYER,
      kind: "BET",
      correlationId: "msg-123",
    });
    expect(command.money.toString()).toBe("25.00");
    expect(command.money.currency).toBe("BRL");
  });

  test.each([
    ["JSON inválido", "{not json", "INVALID_JSON"],
    ["corpo vazio", undefined, "INVALID_JSON"],
    ["array", "[]", "INVALID_ENVELOPE"],
    ["sem messageId", JSON.stringify(envelope({ messageId: undefined })), "INVALID_ENVELOPE"],
    ["messageId vazio", JSON.stringify(envelope({ messageId: "" })), "INVALID_ENVELOPE"],
    ["type errado", JSON.stringify(envelope({ type: "Other" })), "INVALID_ENVELOPE"],
    ["occurredAt inválido", JSON.stringify(envelope({ occurredAt: "ontem" })), "INVALID_ENVELOPE"],
    ["data ausente", JSON.stringify(envelope({ data: null })), "INVALID_ENVELOPE"],
    ["sem idempotencyKey", JSON.stringify(envelope({}, { idempotencyKey: undefined })), "INVALID_PAYLOAD"],
    ["amount em notação científica", JSON.stringify(envelope({}, { money: { amount: "1e3", currency: "BRL" } })), "INVALID_PAYLOAD"],
    ["amount number", JSON.stringify(envelope({}, { money: { amount: 25, currency: "BRL" } })), "INVALID_PAYLOAD"],
    ["amount com 3 casas", JSON.stringify(envelope({}, { money: { amount: "25.005", currency: "BRL" } })), "INVALID_PAYLOAD"],
    ["OPENING pela fila", JSON.stringify(envelope({}, { kind: "OPENING" })), "INVALID_PAYLOAD"],
    ["walletId não-UUID", JSON.stringify(envelope({}, { walletId: "w-1" })), "INVALID_PAYLOAD"],
    ["ROLLBACK sem referência", JSON.stringify(envelope({}, { kind: "ROLLBACK" })), "INVALID_PAYLOAD"],
  ])("%s → veneno %s", (_label, body, reason) => {
    expect(reasonOf(body)).toBe(reason);
  });
});

describe("classifyFailure (D9)", () => {
  test.each([
    ["payload inválido", new PoisonMessageError("INVALID_PAYLOAD", "x"), { kind: "permanent", reason: "INVALID_PAYLOAD" }],
    ["comando inválido no use case", new InvalidCommandError("x"), { kind: "permanent", reason: "INVALID_PAYLOAD" }],
    ["conflito de idempotência", new IdempotencyConflictError("x"), { kind: "permanent", reason: "IDEMPOTENCY_CONFLICT" }],
    ["messageId com outro payload", new InboxPayloadMismatchError("x"), { kind: "permanent", reason: "INBOX_PAYLOAD_MISMATCH" }],
    ["infra transitória", new TransientInfrastructureError("x"), { kind: "transient", expected: true }],
    ["erro inesperado (redrive é a rede)", new LostUpdateError("x"), { kind: "transient", expected: false }],
    ["qualquer outra coisa", new Error("boom"), { kind: "transient", expected: false }],
  ])("%s", (_label, error, expected) => {
    expect(classifyFailure(error)).toEqual(expected as ReturnType<typeof classifyFailure>);
  });
});

describe("retryDelaySeconds: min(base · 2^(n−1), max)", () => {
  test("cresce por ApproximateReceiveCount e respeita o teto", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelaySeconds(n, 2, 20))).toEqual([2, 4, 8, 16, 20, 20]);
  });

  test("contagem ausente/absurda não estoura", () => {
    expect(retryDelaySeconds(0, 2, 60)).toBe(2);
    expect(retryDelaySeconds(10_000, 2, 60)).toBe(60);
  });
});
