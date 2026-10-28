import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { InvariantViolationError } from "../../../src/domain/errors";
import { Money } from "../../../src/domain/money";
import { type CanonicalValue, canonicalJson, canonicalWagerPayload, payloadHash, type WagerPayload } from "../../../src/domain/payload-hash";
import { WagerTransactionKind } from "../../../src/domain/wager-transaction";

const base: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

/** Escrito à mão (não derivado da implementação): é a especificação de D4. */
const EXPECTED_CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
  '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("JSON canônico (D4)", () => {
  test("chaves ordenadas recursivamente, sem espaços, ausentes omitidos", () => {
    expect(canonicalWagerPayload(base)).toBe(EXPECTED_CANONICAL);
  });

  test("payloadHash = SHA-256 hex minúsculo do JSON canônico em UTF-8", () => {
    const hash = payloadHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256(EXPECTED_CANONICAL));
  });

  test("referência entra no hash quando presente, na posição ordenada", () => {
    const withRef = { ...base, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "transaction-100" };
    expect(canonicalWagerPayload(withRef)).toContain(
      '"providerId":"provider-a","referenceExternalTransactionId":"transaction-100","roundId":"round-987"',
    );
    expect(payloadHash(withRef)).not.toBe(payloadHash({ ...base, kind: WagerTransactionKind.Refund }));
  });

  test("ordem de inserção das chaves não importa", () => {
    const shuffled: WagerPayload = {
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      kind: WagerTransactionKind.Bet,
      walletId: base.walletId,
      gameId: "fortune-chimp",
      roundId: "round-987",
      playerId: base.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(payloadHash(shuffled)).toBe(payloadHash(base));
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" }],
    ["walletId", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["amount", { money: Money.from({ amount: "25.01", currency: "BRL" }) }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
  ])("mudar %s muda o hash (mesma key ⇒ conflito, não replay)", (_field, change) => {
    expect(payloadHash({ ...base, ...change })).not.toBe(payloadHash(base));
  });

  test("escapes de JSON e unicode são estáveis", () => {
    expect(canonicalJson({ b: 'aspas " e \\ barra', a: "ação ✓" })).toBe('{"a":"ação ✓","b":"aspas \\" e \\\\ barra"}');
    expect(canonicalJson({ z: [true, null, { y: "1", x: "2" }] })).toBe('{"z":[true,null,{"x":"2","y":"1"}]}');
  });

  test.each([
    ["number", 1],
    ["float", 0.1],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["Map", new Map()],
  ])("recusa %s (dinheiro nunca é número; só JSON puro)", (_label, value) => {
    expect(() => canonicalJson({ v: value as unknown as CanonicalValue })).toThrow(InvariantViolationError);
  });
});
