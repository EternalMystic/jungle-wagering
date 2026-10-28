import { createHash } from "node:crypto";
import { InvariantViolationError } from "./errors";
import type { Money } from "./money";
import type { WagerTransactionKind } from "./wager-transaction";

/**
 * Campos de negócio que entram no hash (D4). Fora: header, idempotencyKey, messageId,
 * occurredAt e qualquer metadado de transporte — assim a mesma operação vinda por HTTP
 * e depois por SQS é replay, não conflito.
 */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
}

export type CanonicalValue = string | boolean | null | undefined | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

/**
 * JSON canônico: chaves ordenadas recursivamente (ordem de code unit UTF-16, a de
 * `Array.prototype.sort`), sem espaços, propriedades `undefined` omitidas, strings com o
 * escape padrão de JSON. Números são RECUSADOS: nenhum campo de negócio é numérico e
 * dinheiro é string — aceitar number reabriria a porta para float e para `1` ≠ `1.0`.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as { readonly [key: string]: CanonicalValue };
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new InvariantViolationError(`canonicalJson: unsupported value of type ${typeof value}`);
}

/** Objeto canônico do payload (D4); `referenceExternalTransactionId`/rodada/jogo omitidos quando ausentes. */
export function canonicalWagerPayload(payload: WagerPayload): string {
  return canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.toString(), currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

/** SHA-256 hex (64 chars minúsculos) do JSON canônico em UTF-8. */
export function payloadHash(payload: WagerPayload): string {
  return createHash("sha256").update(canonicalWagerPayload(payload), "utf8").digest("hex");
}
