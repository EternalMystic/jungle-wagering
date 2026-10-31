import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidCommandError,
  TransientInfrastructureError,
} from "../../application/errors";
import { PoisonMessageError, PoisonReason } from "./wager-message";

// Erro inesperado tenta de novo tambem; a redrive tira da fila se continuar falhando.
export type FailureClass =
  | { readonly kind: "permanent"; readonly reason: PoisonReason }
  | { readonly kind: "transient"; readonly expected: boolean };

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof PoisonMessageError) return { kind: "permanent", reason: err.reason };
  if (err instanceof InvalidCommandError) return { kind: "permanent", reason: PoisonReason.InvalidPayload };
  if (err instanceof IdempotencyConflictError) return { kind: "permanent", reason: PoisonReason.IdempotencyConflict };
  if (err instanceof InboxPayloadMismatchError) return { kind: "permanent", reason: PoisonReason.InboxPayloadMismatch };
  if (err instanceof TransientInfrastructureError) return { kind: "transient", expected: true };
  return { kind: "transient", expected: false };
}

export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const n = Math.max(1, Math.min(receiveCount, 32));
  const delay = baseSeconds * 2 ** (n - 1);
  return Math.min(delay, maxSeconds);
}
