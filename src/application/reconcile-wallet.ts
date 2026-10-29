import type { Metrics } from "./ports/metrics";
import type { ReconciliationResult, WalletReads } from "./ports/wallet-reads";

export interface ReconciliationReporter {
  divergence(walletId: string): void;
}

export class ReconcileWallet {
  constructor(private readonly reads: WalletReads, private readonly metrics: Metrics,
    private readonly reporter: ReconciliationReporter) {}

  async execute(walletId: string): Promise<ReconciliationResult | undefined> {
    const result = await this.reads.reconciliation(walletId);
    if (result !== undefined && !result.consistent) {
      this.metrics.reconciliationDivergence();
      this.reporter.divergence(walletId);
    }
    return result;
  }
}
