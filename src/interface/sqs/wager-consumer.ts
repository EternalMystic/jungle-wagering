import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type FaultInjector, FaultPoint } from "../../application/ports/fault-injector";
import type { QueueDelivery, WagerCommand, WagerResult } from "../../application/process-wager-transaction";
import type { ConsumerConfig, QueueNames } from "../../infrastructure/config/app-config";
import { type Logger, errorText } from "../../infrastructure/logging/json-logger";
import { classifyFailure, retryDelaySeconds } from "./retry-policy";
import { type ParsedWagerMessage, type PoisonReason, parseWagerMessage } from "./wager-message";
import { NO_METRICS, type Metrics } from "../../application/ports/metrics";
import { enrichLogContext, withLogContext } from "../../infrastructure/logging/log-context";

/** Nome do consumidor na PK da inbox `(consumer_name, message_id)`. */
export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

export interface ProcessWagerPort {
  execute(command: WagerCommand, delivery?: QueueDelivery): Promise<WagerResult>;
}

export interface WagerConsumerDeps {
  readonly sqs: SQSClient;
  readonly queues: QueueNames;
  readonly config: ConsumerConfig;
  readonly processWager: ProcessWagerPort;
  readonly faults: FaultInjector;
  readonly logger: Logger;
  readonly generateId: () => string;
  readonly metrics?: Metrics;
}

/** Espera entre falhas do próprio ReceiveMessage (SQS fora, fila inexistente). */
const RECEIVE_ERROR_PAUSE_MS = 1000;
const MAX_ATTRIBUTE_TEXT = 1024;

type Outcome = "acked" | "dead-lettered" | "retry" | "released";

/**
 * Consumer da fila de entrada (D9, §10). Por mensagem:
 *   parse → `ProcessWagerTransaction.execute(command, inbox)` (MESMO use case do HTTP; inbox
 *   na mesma transação) → COMMIT → só então `DeleteMessage`.
 * Falha: classificada em `retry-policy.ts` — permanente vai à DLQ com motivo e sai da fila;
 * transitória volta com visibilidade = backoff por `ApproximateReceiveCount`, e a RedrivePolicy
 * (maxReceiveCount 5) é a rede de segurança.
 *
 * Ordem: mensagens do mesmo `MessageGroupId` (= wallet) são processadas em sequência; grupos
 * diferentes, em paralelo. Isso é OTIMIZAÇÃO: a correção vem do lock por wallet + inbox.
 * Heartbeat: enquanto um lote está em andamento a visibilidade é renovada.
 * SIGTERM (`stop`): para de buscar, conclui o que está em andamento até `shutdownGraceMs`,
 * devolve o resto com visibilidade 0. Nenhuma rede (SQS) com transação SQL aberta: o use case
 * já confirmou quando o `DeleteMessage` sai.
 */
export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;
  /** recebidas e ainda sem destino (ack, DLQ, retry ou devolução) */
  private readonly pending = new Map<string, Message>();

  constructor(private readonly deps: WagerConsumerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.deps.logger.info("sqs consumer started", { queue: this.deps.queues.wagerTransactions });
  }

  /** Drain do SIGTERM. Nunca lança. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const loop = this.loop ?? Promise.resolve();
    const finished = await Promise.race([
      loop.then(() => true),
      Bun.sleep(this.deps.config.shutdownGraceMs).then(() => false),
    ]);
    const leftovers = [...this.pending.values()];
    this.pending.clear();
    await this.release(leftovers);
    this.deps.logger.info("sqs consumer stopped", { drained: finished, released: leftovers.length });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (!this.running) break;
        this.deps.logger.warn("sqs receive failed", { error: errorText(error) });
        await Bun.sleep(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }
      if (messages.length === 0) continue;
      for (const m of messages) this.pending.set(handleOf(m), m);
      if (!this.running) break; // recebidas durante o stop: `stop` as devolve
      await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    const QueueUrl = await this.mainUrl();
    const res = await this.deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: this.deps.config.maxMessages,
        WaitTimeSeconds: this.deps.config.waitTimeSeconds,
        VisibilityTimeout: this.deps.config.visibilityTimeoutSeconds,
        AttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
      { abortSignal: this.abort.signal },
    );
    return res.Messages ?? [];
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = groupOf(m);
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    const heartbeat = setInterval(() => void this.extend(), (this.deps.config.visibilityTimeoutSeconds * 1000) / 3);
    try {
      await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Em sequência; depois de uma falha transitória, o resto do grupo volta para a fila na ordem. */
  private async processGroup(group: Message[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i] as Message;
      if (!this.running) return; // `stop` devolve as que sobraram
      const outcome = await this.handle(message);
      if (outcome === "retry") {
        const rest = group.slice(i + 1);
        for (const m of rest) this.pending.delete(handleOf(m));
        await this.release(rest);
        return;
      }
    }
  }

  private async handle(message: Message): Promise<Outcome> {
    return withLogContext({ messageId: message.MessageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: Message): Promise<Outcome> {
    const receiveCount = receiveCountOf(message);
    const log = { sqsMessageId: message.MessageId, receiveCount };
    let parsed: ParsedWagerMessage | undefined;
    try {
      parsed = parseWagerMessage(message.Body, this.deps.generateId);
      enrichLogContext({ messageId: parsed.messageId, correlationId: parsed.command.correlationId,
        walletId: parsed.command.walletId, providerId: parsed.command.providerId });
      const result = await this.deps.processWager.execute(parsed.command, {
        consumerName: WAGER_CONSUMER_NAME,
        messageId: parsed.messageId,
      });
      enrichLogContext({ transactionId: result.transactionId });
      // COMMIT confirmado. Morrer aqui = mensagem volta e a inbox reconhece (§13 concorrência 5)
      this.deps.faults.checkpoint(FaultPoint.AfterCommitBeforeAck);
      await this.ack(message);
      this.deps.logger.info("sqs message processed", {
        ...log,
        ...context(parsed),
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return "acked";
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "permanent") {
        return this.deadLetter(message, failure.reason, error, { ...log, ...context(parsed) });
      }
      return this.retry(message, receiveCount, error, failure.expected, { ...log, ...context(parsed) });
    }
  }

  private async ack(message: Message): Promise<void> {
    this.pending.delete(handleOf(message));
    try {
      await this.deps.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.mainUrl(), ReceiptHandle: handleOf(message) }));
    } catch (error) {
      // efeito já confirmado: a reentrega será replay pela inbox
      this.deps.logger.warn("sqs delete failed after commit; redelivery will be deduplicated by the inbox", {
        sqsMessageId: message.MessageId,
        error: errorText(error),
      });
    }
  }

  /** Permanente: DLQ explícita (com motivo) ANTES de apagar — crash no meio = reentrega e nova DLQ (dedup FIFO). */
  private async deadLetter(message: Message, reason: PoisonReason, error: unknown, log: Record<string, unknown>): Promise<Outcome> {
    const detail = truncate(errorText(error));
    try {
      await this.deps.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.deadLetterUrl(),
          MessageBody: message.Body ?? "",
          MessageGroupId: groupOf(message),
          MessageDeduplicationId: message.MessageId ?? handleOf(message).slice(0, 128),
          MessageAttributes: {
            reason: { DataType: "String", StringValue: reason },
            detail: { DataType: "String", StringValue: detail },
            sourceMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
            receiveCount: { DataType: "Number", StringValue: String(receiveCountOf(message)) },
          },
        }),
      );
    } catch (sendError) {
      this.deps.logger.error("sqs dead-letter send failed; message stays in the queue", {
        sqsMessageId: message.MessageId,
        reason,
        error: errorText(sendError),
      });
      return this.retry(message, receiveCountOf(message), sendError, false, log);
    }
    (this.deps.metrics ?? NO_METRICS).sqsDlq(reason);
    await this.ack(message);
    this.deps.logger.warn("sqs message dead-lettered", { ...fields(log), reason, error: detail });
    return "dead-lettered";
  }

  private async retry(
    message: Message,
    receiveCount: number,
    error: unknown,
    expected: boolean,
    log: Record<string, unknown>,
  ): Promise<Outcome> {
    this.pending.delete(handleOf(message));
    const delay = retryDelaySeconds(receiveCount, this.deps.config.retryBaseSeconds, this.deps.config.retryMaxSeconds);
    (this.deps.metrics ?? NO_METRICS).sqsRetry();
    const entry = { ...fields(log), retryInSeconds: delay, transient: expected, error: errorText(error) };
    if (expected) this.deps.logger.warn("sqs message will be retried", entry);
    else this.deps.logger.error("sqs message will be retried", entry);
    await this.changeVisibility(message, delay);
    return "retry";
  }

  private async release(messages: readonly Message[]): Promise<void> {
    await Promise.all(messages.map((m) => this.changeVisibility(m, 0)));
  }

  private async extend(): Promise<void> {
    await Promise.all([...this.pending.values()].map((m) => this.changeVisibility(m, this.deps.config.visibilityTimeoutSeconds)));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.deps.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: await this.mainUrl(), ReceiptHandle: handleOf(message), VisibilityTimeout: seconds }),
      );
    } catch (error) {
      // sem a mudança, vale o visibility timeout corrente: a mensagem volta do mesmo jeito
      this.deps.logger.warn("sqs change visibility failed", { sqsMessageId: message.MessageId, seconds, error: errorText(error) });
    }
  }

  private async mainUrl(): Promise<string> {
    this.queueUrl ??= await this.urlOf(this.deps.queues.wagerTransactions);
    return this.queueUrl;
  }

  private async deadLetterUrl(): Promise<string> {
    this.dlqUrl ??= await this.urlOf(this.deps.queues.wagerTransactionsDlq);
    return this.dlqUrl;
  }

  private async urlOf(QueueName: string): Promise<string> {
    const res = await this.deps.sqs.send(new GetQueueUrlCommand({ QueueName }));
    if (!res.QueueUrl) throw new Error(`GetQueueUrl ${QueueName} returned no QueueUrl`);
    return res.QueueUrl;
  }
}

function handleOf(message: Message): string {
  if (!message.ReceiptHandle) throw new Error(`SQS message ${message.MessageId} without ReceiptHandle`);
  return message.ReceiptHandle;
}

function groupOf(message: Message): string {
  return message.Attributes?.MessageGroupId ?? "ungrouped";
}

function receiveCountOf(message: Message): number {
  const raw = message.Attributes?.ApproximateReceiveCount ?? "1";
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

function context(parsed: ParsedWagerMessage | undefined): Record<string, string | undefined> {
  if (parsed === undefined) return {};
  return {
    messageId: parsed.messageId,
    correlationId: parsed.command.correlationId,
    walletId: parsed.command.walletId,
    providerId: parsed.command.providerId,
  };
}

function fields(log: Record<string, unknown>): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(log)) out[k] = typeof v === "number" ? v : v === undefined ? undefined : String(v);
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_ATTRIBUTE_TEXT ? `${text.slice(0, MAX_ATTRIBUTE_TEXT - 1)}…` : text;
}
