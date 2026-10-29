import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import type { MoneyProps } from "../../domain/money";

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface WalletReads {
  ledger(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[] | undefined>;
  /** Uma única leitura consistente, inclusive sob commits financeiros concorrentes. */
  reconciliation(walletId: string): Promise<ReconciliationResult | undefined>;
}
