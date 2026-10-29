/**
 * Drain do SIGTERM (D9) em unidade, com um SQS FALSO (só aqui, em test/unit). Motivo: no
 * Windows o Bun entrega SIGTERM como TerminateProcess — handler nenhum roda —, então o caminho
 * `beforeApplicationShutdown → consumer.stop()` não é exercitável por sinal em processo real
 * nesta plataforma (D21). O comportamento contra a fila real está em test/integration.
 */
import { describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { NO_FAULTS } from "../../src/application/ports/fault-injector";
import type { WagerCommand, WagerResult } from "../../src/application/process-wager-transaction";
import type { ConsumerConfig } from "../../src/infrastructure/config/app-config";
import type { Logger } from "../../src/infrastructure/logging/json-logger";
import { WagerQueueConsumer } from "../../src/interface/sqs/wager-consumer";

const WALLET_A = "0192f291-27dd-7d3f-8071-5f8685deef37";
const WALLET_B = "0192f291-27dd-7d3f-8071-5f8685deef38";
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

function sqsMessage(handle: string, walletId: string, ext: string): Message {
  return {
    MessageId: `sqs-${handle}`,
    ReceiptHandle: handle,
    Attributes: { MessageGroupId: walletId, ApproximateReceiveCount: "1" },
    Body: JSON.stringify({
      messageId: `msg-${handle}`,
      type: "WagerTransactionRequested",
      occurredAt: "2026-10-29T12:00:00.000Z",
      data: {
        providerId: "provider-a",
        externalTransactionId: ext,
        idempotencyKey: `provider-a:${ext}`,
        playerId: PLAYER,
        walletId,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      },
    }),
  };
}

/** SQS de mentira: um lote no primeiro Receive; depois, long poll que só termina no abort. */
class FakeSqs {
  readonly deleted: string[] = [];
  readonly visibility: { handle: string; seconds: number }[] = [];
  private delivered = false;

  constructor(private readonly batch: Message[]) {}

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: `https://sqs/${command.input.QueueName}` };
    if (command instanceof ReceiveMessageCommand) {
      if (!this.delivered) {
        this.delivered = true;
        return { Messages: this.batch };
      }
      await new Promise<void>((_, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      return {};
    }
    if (command instanceof DeleteMessageCommand) {
      this.deleted.push(command.input.ReceiptHandle ?? "?");
      return {};
    }
    if (command instanceof ChangeMessageVisibilityCommand) {
      this.visibility.push({ handle: command.input.ReceiptHandle ?? "?", seconds: command.input.VisibilityTimeout ?? -1 });
      return {};
    }
    throw new Error(`comando inesperado: ${String(command)}`);
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function config(shutdownGraceMs: number): ConsumerConfig {
  return {
    enabled: true,
    waitTimeSeconds: 20,
    maxMessages: 10,
    visibilityTimeoutSeconds: 30,
    retryBaseSeconds: 2,
    retryMaxSeconds: 60,
    shutdownGraceMs,
  };
}

const processed = (): WagerResult => ({
  transactionId: "tx",
  status: "PROCESSED",
  balance: undefined,
  failureCode: undefined,
  idempotentReplay: false,
});

function consumer(sqs: FakeSqs, execute: (c: WagerCommand) => Promise<WagerResult>, graceMs: number): WagerQueueConsumer {
  return new WagerQueueConsumer({
    sqs: sqs as unknown as SQSClient,
    queues: { wagerTransactions: "in.fifo", wagerTransactionsDlq: "dlq.fifo", walletEvents: "ev.fifo" },
    config: config(graceMs),
    processWager: { execute },
    faults: NO_FAULTS,
    logger: silent,
    generateId: () => "id",
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`não aconteceu: ${what}`);
}

describe("WagerQueueConsumer.stop — drain", () => {
  test("conclui a mensagem em andamento (commit → ack) e devolve com visibilidade 0 a que não começou", async () => {
    const sqs = new FakeSqs([sqsMessage("a1", WALLET_A, "a1"), sqsMessage("a2", WALLET_A, "a2"), sqsMessage("b1", WALLET_B, "b1")]);
    const started: string[] = [];
    let releaseA1: () => void = () => {};
    const a1Done = new Promise<void>((resolve) => {
      releaseA1 = resolve;
    });
    const c = consumer(
      sqs,
      async (cmd) => {
        started.push(cmd.externalTransactionId);
        if (cmd.externalTransactionId === "a1") await a1Done;
        return processed();
      },
      5_000,
    );

    c.start();
    await until(() => started.includes("a1") && sqs.deleted.includes("b1"), "a1 em andamento e b1 confirmada");
    const stopping = c.stop();
    releaseA1();
    await stopping;

    expect(started.sort()).toEqual(["a1", "b1"]); // a2 nunca começou
    expect(sqs.deleted.sort()).toEqual(["a1", "b1"]);
    expect(sqs.visibility.filter((v) => v.seconds === 0)).toEqual([{ handle: "a2", seconds: 0 }]);
  });

  test("prazo de drain vencido: a mensagem presa é devolvida com visibilidade 0 (a inbox deduplica se ela ainda confirmar)", async () => {
    const sqs = new FakeSqs([sqsMessage("s1", WALLET_A, "s1")]);
    let started = false;
    const c = consumer(
      sqs,
      async () => {
        started = true;
        await new Promise(() => {}); // nunca termina
        return processed();
      },
      50,
    );

    c.start();
    await until(() => started, "s1 em andamento");
    await c.stop();

    expect(sqs.deleted).toEqual([]);
    expect(sqs.visibility.filter((v) => v.seconds === 0)).toEqual([{ handle: "s1", seconds: 0 }]);
  });
});
