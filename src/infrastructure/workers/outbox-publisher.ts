import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type FaultInjector, FaultPoint } from "../../application/ports/fault-injector";
import type { Logger } from "../logging/json-logger";
import type { SqlBackgroundStore } from "../persistence/sql-background-store";

export class OutboxPublisher {
  outboxLagSeconds = 0;

  constructor(private readonly store: SqlBackgroundStore, private readonly sqs: SQSClient,
    private readonly queueUrl: string, private readonly instanceId: string,
    private readonly faults: FaultInjector, private readonly logger: Logger) {}

  async tick(): Promise<number> {
    this.outboxLagSeconds = await this.store.lagSeconds();
    const claims = await this.store.claimOutbox(this.instanceId);
    if (claims.length > 0) this.faults.checkpoint(FaultPoint.AfterClaimBeforePublish);
    for (const original of claims) {
      const claim = await this.store.renew(original);
      if (claim === undefined) continue;
      try {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(claim.message.payload), MessageGroupId: claim.message.aggregateId,
          MessageDeduplicationId: claim.message.id }), { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        // Não persistir mensagens de erro do SDK: podem conter o corpo financeiro enviado.
        await this.store.finish(claim, "SQS_PUBLISH_FAILED");
        this.logger.warn("outbox publication scheduled for retry", { messageId: claim.message.id, walletId: claim.message.aggregateId });
        continue;
      }
      this.faults.checkpoint(FaultPoint.AfterPublishBeforeMark);
      await this.store.finish(claim);
    }
    this.outboxLagSeconds = await this.store.lagSeconds();
    return claims.length;
  }
}
