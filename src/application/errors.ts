/**
 * Erros da camada de aplicação. Cada um tem UMA classe de resposta (D5) — a interface
 * traduz, a aplicação não conhece HTTP.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Comando mal formado (campo ausente, valor inválido, kind proibido). Corrigir antes de reenviar. */
export class InvalidCommandError extends ApplicationError {
  readonly code = "INVALID_PAYLOAD";
}

/** Já existe wallet para player+moeda (`uq_wallet_player_currency`). */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

/**
 * Mesma `Idempotency-Key` com payload diferente, ou mesmo `(providerId, externalTransactionId)`
 * com outra key (D4). Nunca é replay; reenviar com a mesma key não muda o resultado.
 */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

/**
 * O mesmo `messageId` da fila chegou com OUTRO payload (D9): não é redelivery, é veneno.
 * Permanente — vai para a DLQ, nada é confirmado.
 */
export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = "INBOX_PAYLOAD_MISMATCH";
}

/** Infra temporariamente indisponível (lock_timeout, conexão, pool). Reenviar com a mesma key. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Perdeu a corrida pelo INSERT de uma chave única de idempotência (23505). A transação
 * SQL já foi desfeita; o use case relê e responde replay/conflito. Nunca chega ao cliente.
 */
export class IdempotencyRaceLostError extends ApplicationError {
  readonly code = "IDEMPOTENCY_RACE_LOST";
}

/** UPDATE condicionado da wallet afetou 0 linhas apesar do lock: erro de programação (500). */
export class LostUpdateError extends ApplicationError {
  readonly code = "LOST_UPDATE";
}
