import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidCommandError,
  TransientInfrastructureError,
} from "../../application/errors";
import { PoisonMessageError, PoisonReason } from "./wager-message";

/**
 * Classificação D9 de uma FALHA do processamento (resultado de negócio — PROCESSED, REJECTED,
 * PENDING_REFERENCE, WALLET_NOT_FOUND — não é falha: commit → ack).
 *
 * - `permanent`: nunca vai dar certo → DLQ explícita com motivo, e apaga da fila (não bloqueia
 *   o grupo FIFO nem gasta 5 recebimentos).
 * - `transient`: infra (Postgres fora, lock_timeout, pool) → rollback já feito; volta à fila
 *   com backoff. Erro INESPERADO também cai aqui: reprocessar é seguro (inbox + idempotência)
 *   e a redrive (maxReceiveCount) é a rede de segurança que o tira da fila.
 */
export type FailureClass =
  | { readonly kind: "permanent"; readonly reason: PoisonReason }
  | { readonly kind: "transient"; readonly expected: boolean };

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof PoisonMessageError) return { kind: "permanent", reason: error.reason };
  if (error instanceof InvalidCommandError) return { kind: "permanent", reason: PoisonReason.InvalidPayload };
  if (error instanceof IdempotencyConflictError) return { kind: "permanent", reason: PoisonReason.IdempotencyConflict };
  if (error instanceof InboxPayloadMismatchError) return { kind: "permanent", reason: PoisonReason.InboxPayloadMismatch };
  if (error instanceof TransientInfrastructureError) return { kind: "transient", expected: true };
  return { kind: "transient", expected: false };
}

/** Visibilidade até a próxima tentativa: `min(base · 2^(n−1), max)`, n = ApproximateReceiveCount ≥ 1. */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const n = Math.max(1, Math.min(receiveCount, 32));
  return Math.min(baseSeconds * 2 ** (n - 1), maxSeconds);
}
