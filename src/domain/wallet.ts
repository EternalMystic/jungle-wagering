import { InsufficientFundsError, InvariantViolationError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** ids do crédito de abertura; usados só se `initialBalance` > 0 */
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** CREDIT v1 (balance_before 0) quando há saldo inicial; ausente se abriu com 0.00 */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

/**
 * Aggregate root. O saldo só muda por `credit`/`debit`, que devolvem o lançamento que
 * explica a mudança e sobem `version` em exatamente 1 (espelha os triggers diferidos
 * do banco). `version` começa em 1 e não muda sem mudança de saldo.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.id.length === 0 || props.playerId.length === 0) {
      throw new InvariantViolationError("wallet id and playerId are required");
    }
    const initial = props.initialBalance;
    if (initial.isNegative()) throw new InvariantViolationError("initial balance cannot be negative");
    const wallet = new Wallet(props.id, props.playerId, initial.currency, initial, 1, props.at, props.at);
    if (initial.isZero()) return { wallet, openingEntry: undefined };
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initial,
      balanceBefore: Money.zero(initial.currency),
      balanceAfter: initial,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.isGreaterThanOrEqual(money);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, props);
  }

  /** Lança InsufficientFundsError se o saldo não cobre; o caller escolhe o failureCode antes. */
  debit(props: MovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, props);
  }

  apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    return this.move(direction, props);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) throw new InvariantViolationError("movement amount must be > 0");
    if (direction === LedgerDirection.Debit && !this._balance.isGreaterThanOrEqual(props.money)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), props.money.toString());
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    // o lançamento valida a aritmética ANTES de o agregado mudar: falha não deixa meio-estado
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    this._balance.assertSameCurrency(money);
  }
}
