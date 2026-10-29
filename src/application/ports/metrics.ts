import type { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";

export interface Metrics {
  transaction(status: WagerTransactionStatus, kind: WagerTransactionKind): void;
  replay(channel: "http" | "sqs"): void;
  inboxDuplicate(): void;
  sqsRetry(): void;
  sqsDlq(reason: string): void;
  lockConflict(): void;
  processingSeconds(seconds: number): void;
  reconciliationDivergence(): void;
}

export const NO_METRICS: Metrics = {
  transaction() {}, replay() {}, inboxDuplicate() {}, sqsRetry() {}, sqsDlq() {},
  lockConflict() {}, processingSeconds() {}, reconciliationDivergence() {},
};
