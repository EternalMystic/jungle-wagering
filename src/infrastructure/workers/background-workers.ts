import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { FaultInjector } from "../../application/ports/fault-injector";
import type { ResolvePendingReferences } from "../../application/resolve-pending-references";
import type { Logger } from "../logging/json-logger";
import type { SqlBackgroundStore } from "../persistence/sql-background-store";
import { OutboxPublisher } from "./outbox-publisher";
import { withLogContext } from "../logging/log-context";

export class BackgroundWorkers {
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly abort = new AbortController();
  private publisher: OutboxPublisher | undefined;

  constructor(private readonly store: SqlBackgroundStore, private readonly resolver: ResolvePendingReferences,
    private readonly sqs: SQSClient, private readonly queueName: string, private readonly instanceId: string,
    private readonly faults: FaultInjector, private readonly logger: Logger) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [this.run(() => this.publish()), this.run(() => this.resolve())];
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await Promise.all(this.loops);
  }

  get outboxLagSeconds(): number { return this.publisher?.outboxLagSeconds ?? 0; }

  private async publish(): Promise<void> {
    if (this.publisher === undefined) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }),
        { abortSignal: AbortSignal.timeout(10_000) });
      if (QueueUrl === undefined) throw new Error("wallet events queue has no URL");
      this.publisher = new OutboxPublisher(this.store, this.sqs, QueueUrl, this.instanceId, this.faults, this.logger);
    }
    await this.publisher.tick();
  }

  private async resolve(): Promise<void> {
    const claims = await this.store.claimPending(new Date());
    for (const claim of claims) {
      if (!this.running) break;
      await withLogContext({ transactionId: claim.transactionId, walletId: claim.walletId }, async () => {
        try { await this.resolver.execute(claim); }
        catch { this.logger.warn("pending reference attempt rolled back"); }
      });
    }
  }

  private async run(tick: () => Promise<void>): Promise<void> {
    // Bootstrap termina antes do primeiro checkpoint de crash do publisher (D20).
    while (this.running) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 250);
        if (this.abort.signal.aborted) done();
        else this.abort.signal.addEventListener("abort", done, { once: true });
      });
      if (!this.running) break;
      try { await tick(); }
      catch { this.logger.warn("background worker iteration failed"); }
    }
  }
}
