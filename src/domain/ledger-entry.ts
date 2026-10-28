import { CurrencyMismatchError, InvariantViolationError, LedgerArithmeticError } from "./errors";
import type { Money } from "./money";

/** `const` + união de literais (não `enum` nominal): "DEBIT"/"CREDIT" do banco já são o tipo. */
export const LedgerDirection = {
  Debit: "DEBIT",
  Credit: "CREDIT",
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** versão da wallet DEPOIS deste lançamento (1 lançamento ⇔ 1 incremento) */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger: append-only, sem campo mutável nem método de transição.
 * `create` valida a mesma aritmética que o CHECK `ck_ledger_arithmetic` do banco.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvariantViolationError(`unknown ledger direction ${String(props.direction)}`);
    }
    for (const other of [balanceBefore, balanceAfter]) {
      if (!other.hasCurrency(money.currency)) throw new CurrencyMismatchError(money.currency, other.currency);
    }
    if (!money.isPositive()) throw new LedgerArithmeticError("ledger amount must be > 0");
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new LedgerArithmeticError("ledger balances cannot be negative");
    }
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError("walletVersion must be an integer >= 1");
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      money,
      balanceBefore,
      balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new LedgerArithmeticError(
        `${props.direction} ${money.toString()}: ${balanceBefore.toString()} does not lead to ${balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  get currency(): string {
    return this.money.currency;
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
