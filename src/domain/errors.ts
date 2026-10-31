export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

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

export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
}

export class LedgerArithmeticError extends DomainError {
  readonly code = "LEDGER_ARITHMETIC";
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}
