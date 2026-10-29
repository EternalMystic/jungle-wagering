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
        const result = await this.processor.execute(command, delivery);
        enrichLogContext({ transactionId: result.transactionId });
        if (result.idempotentReplay) this.metrics.replay(delivery === undefined ? "http" : "sqs");
        this.logger.info("wager transaction completed", { status: result.status, failureCode: result.failureCode, idempotentReplay: result.idempotentReplay });
        return result;
      } catch (error) {
        this.logger.warn("wager transaction failed", { error: errorText(error) });
        throw error;
      } finally { this.metrics.processingSeconds((performance.now() - started) / 1000); }
    });
  }
}
