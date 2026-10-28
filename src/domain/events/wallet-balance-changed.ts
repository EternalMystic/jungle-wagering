import { InvariantViolationError } from "../errors";
import type { LedgerDirection, WalletLedgerEntry } from "../ledger-entry";
import type { MoneyProps } from "../money";
import type { Wallet } from "../wallet";
import { type EventContext, IntegrationEvent } from "./integration-event";

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/** Somente quando o saldo muda: um por lançamento do ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  /** Exige que `entry` seja o ÚLTIMO movimento de `wallet` (evento reflete o estado real). */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError(`ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not ${wallet.id}`);
    }
    if (entry.walletVersion !== wallet.version || !entry.balanceAfter.equals(wallet.balance)) {
      throw new InvariantViolationError(`ledger entry ${entry.id} is not the latest movement of wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
