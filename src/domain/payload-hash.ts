import { createHash } from "node:crypto";
import { InvariantViolationError } from "./errors";
import type { Money } from "./money";
import type { WagerTransactionKind } from "./wager-transaction";

// Transporte fica fora do hash para HTTP e SQS reconhecerem a mesma operacao.
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

// Nao aceitar number aqui: dinheiro chega como string.
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as { readonly [key: string]: CanonicalValue };
    // Nao trocar por localeCompare: muda o hash dependendo do ambiente.
    const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new InvariantViolationError(`canonicalJson: unsupported value of type ${typeof value}`);
}

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

export function payloadHash(payload: WagerPayload): string {
  return sha256Hex(canonicalWagerPayload(payload));
}

/** Hash do crédito de abertura (OPENING interno): mesmo algoritmo, campos da abertura. */
export function openingPayloadHash(props: { readonly walletId: string; readonly playerId: string; readonly money: Money }): string {
  return sha256Hex(
    canonicalJson({
      walletId: props.walletId,
      playerId: props.playerId,
      kind: "OPENING",
      money: { amount: props.money.toString(), currency: props.money.currency },
    }),
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
