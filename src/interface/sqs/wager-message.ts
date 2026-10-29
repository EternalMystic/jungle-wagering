import type { WagerCommand } from "../../application/process-wager-transaction";
import { HttpProblem } from "../http/http-problem";
import { correlationIdFrom, parseIdempotencyKey, parseWagerCommand } from "../http/wagering/dto";

/** Tipo de mensagem da fila de entrada (§10). */
export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

const MAX_MESSAGE_ID = 256;

/** Por que uma mensagem é veneno (atributo `reason` na DLQ). */
export const PoisonReason = {
  InvalidJson: "INVALID_JSON",
  InvalidEnvelope: "INVALID_ENVELOPE",
  InvalidPayload: "INVALID_PAYLOAD",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  InboxPayloadMismatch: "INBOX_PAYLOAD_MISMATCH",
} as const;

export type PoisonReason = (typeof PoisonReason)[keyof typeof PoisonReason];

/** Mensagem que nunca vai dar certo, não importa quantas vezes seja reentregue (D9: permanente). */
export class PoisonMessageError extends Error {
  constructor(
    readonly reason: PoisonReason,
    message: string,
  ) {
    super(message);
    this.name = "PoisonMessageError";
  }
}

export interface ParsedWagerMessage {
  readonly messageId: string;
  readonly command: WagerCommand;
}

/**
 * Corpo da mensagem SQS → comando do MESMO use case do HTTP. A validação de `data` é a
 * mesma do DTO HTTP (dinheiro só por `Money.from`, kinds submetíveis, UUIDs); a chave de
 * idempotência vem em `data.idempotencyKey` (o equivalente ao header).
 */
export function parseWagerMessage(body: string | undefined, generateId: () => string): ParsedWagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw new PoisonMessageError(PoisonReason.InvalidJson, "message body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PoisonMessageError(PoisonReason.InvalidEnvelope, "message body must be a JSON object");
  }
  const envelope = parsed as Record<string, unknown>;
  const messageId = envelope.messageId;
  if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > MAX_MESSAGE_ID) {
    throw new PoisonMessageError(PoisonReason.InvalidEnvelope, `messageId must be a non-empty string of at most ${MAX_MESSAGE_ID} chars`);
  }
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw new PoisonMessageError(PoisonReason.InvalidEnvelope, `type must be ${WAGER_MESSAGE_TYPE}`);
  }
  if (typeof envelope.occurredAt !== "string" || Number.isNaN(Date.parse(envelope.occurredAt))) {
    throw new PoisonMessageError(PoisonReason.InvalidEnvelope, "occurredAt must be an ISO-8601 timestamp");
  }
  const data = envelope.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PoisonMessageError(PoisonReason.InvalidEnvelope, "data must be a JSON object");
  }
  try {
    const idempotencyKey = parseIdempotencyKey((data as Record<string, unknown>).idempotencyKey);
    const correlationId = correlationIdFrom(envelope.correlationId ?? messageId, generateId);
    return { messageId, command: parseWagerCommand(data, idempotencyKey, correlationId) };
  } catch (error) {
    if (error instanceof HttpProblem) throw new PoisonMessageError(PoisonReason.InvalidPayload, error.message);
    throw error;
  }
}
