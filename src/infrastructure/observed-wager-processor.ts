import type { Metrics } from "../application/ports/metrics";
import type { ProcessWagerTransaction, QueueDelivery, WagerCommand, WagerResult } from "../application/process-wager-transaction";
import { JsonLogger, errorText } from "./logging/json-logger";
import { enrichLogContext, withLogContext } from "./logging/log-context";

export class ObservedWagerProcessor {
  private readonly logger = new JsonLogger("wager-processing");
  constructor(private readonly processor: ProcessWagerTransaction, private readonly metrics: Metrics) {}

  execute(command: WagerCommand, delivery?: QueueDelivery): Promise<WagerResult> {
    return withLogContext({ correlationId: command.correlationId, walletId: command.walletId,
      providerId: command.providerId, messageId: delivery?.messageId }, async () => {
      const started = performance.now();
      try {
        const res = await this.processor.execute(command, delivery);
        enrichLogContext({ transactionId: res.transactionId });
        if (res.idempotentReplay) this.metrics.replay(delivery === undefined ? "http" : "sqs");
        this.logger.info("wager transaction completed", { status: res.status, failureCode: res.failureCode, idempotentReplay: res.idempotentReplay });
        return res;
      } catch (err) {
        this.logger.warn("wager transaction failed", { error: errorText(err) });
        throw err;
      } finally {
        const elapsed = performance.now() - started;
        this.metrics.processingSeconds(elapsed / 1000);
      }
    });
  }
}
