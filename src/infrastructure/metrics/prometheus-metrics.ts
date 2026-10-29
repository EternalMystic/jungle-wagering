import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Metrics } from "../../application/ports/metrics";
import type { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";

export const METRICS = Symbol("METRICS");

export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly transactions = new Counter({ name: "wager_transactions_total", help: "Committed transaction status transitions.", labelNames: ["status", "kind"], registers: [this.registry] });
  private readonly replays = new Counter({ name: "idempotent_replays_total", help: "Persistent idempotency replays.", labelNames: ["channel"], registers: [this.registry] });
  private readonly duplicates = new Counter({ name: "inbox_duplicates_total", help: "Committed inbox duplicates.", registers: [this.registry] });
  private readonly retries = new Counter({ name: "sqs_retries_total", help: "SQS message retry decisions.", registers: [this.registry] });
  private readonly dlq = new Counter({ name: "sqs_dlq_total", help: "Messages explicitly delivered to the DLQ.", labelNames: ["reason"], registers: [this.registry] });
  private readonly conflicts = new Counter({ name: "lock_conflicts_total", help: "Database lock timeouts, deadlocks and serialization conflicts.", registers: [this.registry] });
  private readonly lag = new Gauge({ name: "outbox_lag_seconds", help: "Age of the oldest unpublished event.", registers: [this.registry] });
  private readonly duration = new Histogram({ name: "wager_processing_seconds", help: "Wager use case latency including failed attempts.", buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [this.registry] });
  private readonly divergences = new Counter({ name: "reconciliation_divergences_total", help: "Wallet reconciliation checks reporting divergence.", registers: [this.registry] });

  transaction(status: WagerTransactionStatus, kind: WagerTransactionKind): void { this.transactions.inc({ status, kind }); }
  replay(channel: "http" | "sqs"): void { this.replays.inc({ channel }); }
  inboxDuplicate(): void { this.duplicates.inc(); }
  sqsRetry(): void { this.retries.inc(); }
  sqsDlq(reason: string): void { this.dlq.inc({ reason }); }
  lockConflict(): void { this.conflicts.inc(); }
  processingSeconds(seconds: number): void { this.duration.observe(seconds); }
  reconciliationDivergence(): void { this.divergences.inc(); }

  async text(lagSeconds: number): Promise<string> {
    this.lag.set(lagSeconds);
    return this.registry.metrics();
  }
}
