import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { redrivePolicy } from "../../src/infrastructure/sqs/setup-queues";

/** Cria filas FIFO descartáveis (nome único por execução) e as apaga no fim. */
export class TempQueues {
  private readonly urls: string[] = [];

  constructor(private readonly sqs: SQSClient) {}

  async fifo(prefix: string, extra: Record<string, string> = {}): Promise<{ url: string; arn: string }> {
    const name = `${prefix}-${randomUUID().slice(0, 8)}.fifo`;
    const res = await this.sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "30", ...extra },
      }),
    );
    if (!res.QueueUrl) throw new Error(`CreateQueue ${name} sem QueueUrl`);
    this.urls.push(res.QueueUrl);
    const attrs = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: res.QueueUrl, AttributeNames: ["QueueArn"] }),
    );
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) throw new Error(`fila ${name} sem QueueArn`);
    return { url: res.QueueUrl, arn };
  }

  async fifoWithDlq(prefix: string, maxReceiveCount: number) {
    const dlq = await this.fifo(`${prefix}-dlq`);
    const main = await this.fifo(prefix, { RedrivePolicy: redrivePolicy(dlq.arn, maxReceiveCount) });
    return { main, dlq };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.urls.map((QueueUrl) => this.sqs.send(new DeleteQueueCommand({ QueueUrl }))));
  }
}

export async function receive(
  sqs: SQSClient,
  url: string,
  max: number,
  waitSeconds = 1,
): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      AttributeNames: ["All"],
      MessageSystemAttributeNames: ["All"],
    }),
  );
  return res.Messages ?? [];
}

function receiptHandle(message: Message): string {
  if (!message.ReceiptHandle) throw new Error(`mensagem ${message.MessageId} sem ReceiptHandle`);
  return message.ReceiptHandle;
}

export async function ack(sqs: SQSClient, url: string, message: Message): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle(message) }));
}

/** Devolve a mensagem à fila imediatamente (simula falha de processamento sem ack). */
export async function nack(sqs: SQSClient, url: string, message: Message): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: url,
      ReceiptHandle: receiptHandle(message),
      VisibilityTimeout: 0,
    }),
  );
}

/** Recebe e apaga até a fila responder vazia `emptyPolls` vezes seguidas. */
export async function drain(sqs: SQSClient, url: string, emptyPolls = 2, maxPolls = 20): Promise<Message[]> {
  const all: Message[] = [];
  let empty = 0;
  for (let i = 0; i < maxPolls && empty < emptyPolls; i++) {
    const batch = await receive(sqs, url, 10);
    if (batch.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    for (const m of batch) {
      all.push(m);
      await ack(sqs, url, m);
    }
  }
  return all;
}
