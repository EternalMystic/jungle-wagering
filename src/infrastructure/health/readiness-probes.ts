import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ReadinessProbe } from "../../application/ports/readiness-probe";
import type { Orm } from "../persistence/orm";

export class PostgresReadinessProbe implements ReadinessProbe {
  readonly name = "postgres";

  constructor(private readonly orm: Orm) {}

  async check(): Promise<void> {
    await this.orm.em.fork().getConnection().execute("select 1 as ok");
  }
}

export class SqsReadinessProbe implements ReadinessProbe {
  readonly name = "sqs";

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(): Promise<void> {
    const res = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    if (!res.QueueUrl) throw new Error(`GetQueueUrl ${this.queueName} sem QueueUrl`);
  }
}
