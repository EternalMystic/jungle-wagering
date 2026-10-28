import { InvalidMessageStateError } from "./errors";
import type { IntegrationEvent } from "./events/integration-event";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt: Date | undefined;
  readonly lastError: string | undefined;
}

/** Backoff de publicação (D18): 1 s, 2 s, 4 s, … até 5 min; sem limite de tentativas. */
export const OUTBOX_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_BACKOFF_MAX_MS = 5 * 60_000;

export function outboxBackoffMs(attempts: number): number {
  if (attempts < 1) return 0;
  // expoente limitado: 2^19 s já passa do teto, e evita Infinity para attempts enormes
  const exponent = Math.min(attempts - 1, 19);
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** exponent, OUTBOX_BACKOFF_MAX_MS);
}

/**
 * Evento gravado na MESMA transação do efeito (D10). Nunca é descartado: falha de
 * publicação reagenda com backoff; publicado é final (o banco também impede "despublicar").
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** id da mensagem = eventId (chave de dedupe do consumidor); elegível já no occurredAt. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending("markPublished");
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto). */
  scheduleRetry(now: Date, error?: string): void {
    this.assertPending("scheduleRetry");
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + outboxBackoffMs(this._attempts));
    if (error !== undefined) this._lastError = error;
  }

  private assertPending(operation: string): void {
    if (this._publishedAt !== undefined) {
      throw new InvalidMessageStateError(`${operation}: outbox message ${this.id} is already published`);
    }
  }
}
