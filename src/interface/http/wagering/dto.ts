import { HttpProblem } from "../http-problem";
import type { OpenWalletCommand, WalletView } from "../../../application/open-wallet";
import type { WagerCommand, WagerResult } from "../../../application/process-wager-transaction";
import { InvalidMoneyError } from "../../../domain/errors";
import { Money, type MoneyProps } from "../../../domain/money";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";
import type { Wallet } from "../../../domain/wallet";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
const REVERSALS: readonly string[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];
const MAX_IDEMPOTENCY_KEY = 512;
/** ASCII visível, até 128 chars; qualquer outra coisa é descartada e um id novo é gerado. */
const CORRELATION_ID = /^[!-~]{1,128}$/;

const invalid = (message: string) => new HttpProblem(400, "INVALID_PAYLOAD", message);

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid(`${field} must be a non-empty string of at most ${maxLength} chars`);
  }
  return value;
}

function optionalText(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  // D18: null e ausente são a mesma coisa (o hash omite o campo)
  if (body[field] === undefined || body[field] === null) return undefined;
  return text(body, field, maxLength);
}

/** UUID normalizado em minúsculas (o Postgres devolve minúsculas; o escopo compara strings). */
export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function money(body: Record<string, unknown>, field: string): Money {
  const raw = record(body[field], field);
  try {
    return Money.from({ amount: raw.amount as string, currency: raw.currency as string });
  } catch (error) {
    if (error instanceof InvalidMoneyError) throw invalid(`${field}: ${error.message}`);
    throw error;
  }
}

export function parseOpenWallet(body: unknown, correlationId: string): OpenWalletCommand {
  const b = record(body, "body");
  return { playerId: uuid(b.playerId, "playerId"), initialBalance: money(b, "initialBalance"), correlationId };
}

export function parseIdempotencyKey(header: unknown): string {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_IDEMPOTENCY_KEY) {
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", `Idempotency-Key header is required (1..${MAX_IDEMPOTENCY_KEY} chars)`);
  }
  return header;
}

export function correlationIdFrom(header: unknown, generate: () => string): string {
  return typeof header === "string" && CORRELATION_ID.test(header) ? header : generate();
}

export function parseWagerCommand(body: unknown, idempotencyKey: string, correlationId: string): WagerCommand {
  const b = record(body, "body");
  const kind = b.kind;
  if (kind === WagerTransactionKind.Opening) throw invalid("kind OPENING is internal and cannot be submitted");
  if (typeof kind !== "string" || !SUBMITTABLE_KINDS.includes(kind)) {
    throw invalid(`kind must be one of ${SUBMITTABLE_KINDS.join(", ")}`);
  }
  const wagerKind = kind as WagerTransactionKind;
  const referenceExternalTransactionId = optionalText(b, "referenceExternalTransactionId", 256);
  if (REVERSALS.includes(wagerKind) && referenceExternalTransactionId === undefined) {
    throw invalid(`${wagerKind} requires referenceExternalTransactionId`);
  }
  if (wagerKind === WagerTransactionKind.Bet && referenceExternalTransactionId !== undefined) {
    throw invalid("BET cannot carry referenceExternalTransactionId");
  }

  const amount = money(b, "money");
  if (wagerKind === WagerTransactionKind.Loss ? amount.isNegative() : !amount.isPositive()) {
    throw invalid(`money.amount must be ${wagerKind === WagerTransactionKind.Loss ? ">= 0.00" : "> 0.00"} for ${wagerKind}`);
  }
  return {
    idempotencyKey,
    providerId: text(b, "providerId", 128),
    externalTransactionId: text(b, "externalTransactionId", 256),
    playerId: uuid(b.playerId, "playerId"),
    walletId: uuid(b.walletId, "walletId"),
    roundId: text(b, "roundId", 256),
    gameId: text(b, "gameId", 256),
    kind: wagerKind,
    money: amount,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    correlationId,
  };
}

export interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export function walletResponse(w: WalletView | Wallet): WalletResponse {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

/** Mesmo formato para 200, 202 e 422 (D16); o replay devolve o mesmo status do original (D5). */
export interface WagerResponse {
  readonly transactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps | null;
  readonly failureCode: string | null;
  readonly idempotentReplay: boolean;
}

export function wagerResponse(r: WagerResult): WagerResponse {
  return {
    transactionId: r.transactionId ?? null,
    status: r.status,
    balance: r.balance?.toJSON() ?? null,
    failureCode: r.failureCode ?? null,
    idempotentReplay: r.idempotentReplay,
  };
}

export function wagerHttpStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

export interface TransactionResponse {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: string | null;
  readonly balance: MoneyProps | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export function transactionResponse(tx: WagerTransaction): TransactionResponse {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    resolvedAt: tx.resolvedAt?.toISOString() ?? null,
  };
}
