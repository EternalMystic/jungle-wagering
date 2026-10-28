/**
 * Erros de domínio tipados. Nenhum deles é "caminho de negócio" por si só: rejeições
 * de negócio viram `failureCode` persistido (ver failure-codes.ts); estes erros sinalizam
 * entrada inválida num contrato do domínio ou erro de programação (transição proibida,
 * aritmética incoerente).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário mal formado, fora da escala/limite ou moeda inválida. */
export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Débito maior que o saldo. O use case decide o failureCode (aposta × reversão). */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    readonly walletId: string,
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`wallet ${walletId}: balance ${balance} is less than ${requested}`);
  }
}

/** Argumento que viola um invariante de construção de entidade/valor do domínio. */
export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
}

/** Lançamento cujo before ± amount ≠ after (ou moedas/sinais incoerentes). */
export class LedgerArithmeticError extends DomainError {
  readonly code = "LEDGER_ARITHMETIC";
}

/** Transição de estado proibida (ex.: tocar numa transação terminal). Erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

/** Mudança de estado proibida em inbox/outbox (ex.: publicar duas vezes). Erro de programação. */
export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}
