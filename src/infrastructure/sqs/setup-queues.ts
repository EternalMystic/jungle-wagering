import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { QueueNames } from "../config/app-config";

/** D9: após 5 recebimentos sem DeleteMessage a mensagem vai para a DLQ. */
export const WAGER_MAX_RECEIVE_COUNT = 5;
export const WAGER_VISIBILITY_TIMEOUT_SECONDS = 30;

export interface QueueInfo {
  readonly name: string;
  readonly url: string;
  readonly arn: string;
  readonly attributes: Readonly<Record<string, string | undefined>>;
}

export interface QueueTopology {
  readonly wagerTransactions: QueueInfo;
  readonly wagerTransactionsDlq: QueueInfo;
  readonly walletEvents: QueueInfo;
}

const FIFO_ATTRIBUTES = {
  FifoQueue: "true",
  ContentBasedDeduplication: "false",
} as const;

async function describe(sqs: SQSClient, name: string, url: string): Promise<QueueInfo> {
  const res = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }));
  const attributes: Record<string, string | undefined> = res.Attributes ?? {};
  const arn = attributes.QueueArn;
  if (!arn) throw new Error(`fila ${name} sem QueueArn`);
  return { name, url, arn, attributes };
}

const ALREADY_EXISTS: readonly string[] = ["QueueAlreadyExists", "QueueNameExists"];

async function createFifo(sqs: SQSClient, name: string, extra: Record<string, string> = {}): Promise<string> {
  const Attributes = { ...FIFO_ATTRIBUTES, VisibilityTimeout: String(WAGER_VISIBILITY_TIMEOUT_SECONDS), ...extra };
  try {
    const res = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes }));
    if (!res.QueueUrl) throw new Error(`CreateQueue ${name} não devolveu QueueUrl`);
    return res.QueueUrl;
  } catch (error) {
    // fila já existe com atributos diferentes: reaproveita e converge via SetQueueAttributes
    if (!(error instanceof Error) || !ALREADY_EXISTS.includes(error.name)) throw error;
    const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!res.QueueUrl) throw new Error(`GetQueueUrl ${name} não devolveu QueueUrl`);
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: res.QueueUrl, Attributes: { VisibilityTimeout: Attributes.VisibilityTimeout, ...extra } }));
    return res.QueueUrl;
  }
}

export function redrivePolicy(deadLetterTargetArn: string, maxReceiveCount: number): string {
  return JSON.stringify({ deadLetterTargetArn, maxReceiveCount });
}

/**
 * Cria (reexecutável) a topologia de filas: entrada FIFO com redrive para a DLQ FIFO
 * e a fila FIFO de eventos de integração (outbox). A RedrivePolicy é reaplicada com
 * SetQueueAttributes para que reexecuções convirjam ao estado esperado.
 */
export async function setupQueues(sqs: SQSClient, names: QueueNames): Promise<QueueTopology> {
  const dlqUrl = await createFifo(sqs, names.wagerTransactionsDlq);
  const dlq = await describe(sqs, names.wagerTransactionsDlq, dlqUrl);

  const policy = redrivePolicy(dlq.arn, WAGER_MAX_RECEIVE_COUNT);
  const mainUrl = await createFifo(sqs, names.wagerTransactions, { RedrivePolicy: policy });
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: mainUrl, Attributes: { RedrivePolicy: policy } }));

  const eventsUrl = await createFifo(sqs, names.walletEvents);

  return {
    wagerTransactions: await describe(sqs, names.wagerTransactions, mainUrl),
    wagerTransactionsDlq: await describe(sqs, names.wagerTransactionsDlq, dlqUrl),
    walletEvents: await describe(sqs, names.walletEvents, eventsUrl),
  };
}
