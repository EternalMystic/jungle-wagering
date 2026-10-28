/**
 * Prova, contra o emulador SQS REAL do docker-compose, que as semânticas das quais o
 * projeto depende existem: FIFO, MessageGroupId, MessageDeduplicationId e RedrivePolicy
 * (maxReceiveCount). Se este arquivo ficar vermelho, o emulador não serve (D13).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { setupQueues, WAGER_MAX_RECEIVE_COUNT } from "../../src/infrastructure/sqs/setup-queues";
import { ack, drain, nack, receive, TempQueues } from "../support/sqs";

// Cada receive vazio faz long polling de 1 s e `drain` exige 2 vazios seguidos: os
// testes passam do timeout padrão de 5 s do bun por construção, não por lentidão.
const LONG_POLL_TEST_TIMEOUT_MS = 30_000;

const config = loadConfig();
let sqs: SQSClient;
let temp: TempQueues;

beforeAll(() => {
  sqs = createSqsClient(config.aws);
  temp = new TempQueues(sqs);
});

afterAll(async () => {
  await temp.dispose();
  sqs.destroy();
});

async function send(url: string, body: string, groupId: string, dedupId: string) {
  return sqs.send(
    new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }),
  );
}

describe("emulador SQS: semânticas FIFO exigidas", () => {
  test("filas do projeto existem: FIFO e redrive maxReceiveCount=5 para a DLQ", async () => {
    const topology = await setupQueues(sqs, config.queues);

    for (const name of Object.values(config.queues)) {
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(res.QueueUrl).toBeString();
    }
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: topology.wagerTransactions.url, AttributeNames: ["All"] }),
    );
    expect(attrs.Attributes?.FifoQueue).toBe("true");
    const policy = JSON.parse(attrs.Attributes?.RedrivePolicy ?? "{}") as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string | number;
    };
    expect(policy.deadLetterTargetArn).toBe(topology.wagerTransactionsDlq.arn);
    expect(String(policy.maxReceiveCount)).toBe(String(WAGER_MAX_RECEIVE_COUNT));
    expect(topology.wagerTransactionsDlq.attributes.FifoQueue).toBe("true");
    expect(topology.walletEvents.attributes.FifoQueue).toBe("true");
  }, LONG_POLL_TEST_TIMEOUT_MS);

  test("fila FIFO recusa envio sem MessageGroupId", async () => {
    const q = await temp.fifo("spike-nogroup");
    const attempt = sqs.send(new SendMessageCommand({ QueueUrl: q.url, MessageBody: "x", MessageDeduplicationId: "d1" }));
    await expect(attempt).rejects.toThrow();
    expect(await drain(sqs, q.url)).toHaveLength(0);
  }, LONG_POLL_TEST_TIMEOUT_MS);

  test("ordem preservada dentro do mesmo MessageGroupId", async () => {
    const q = await temp.fifo("spike-order");
    const bodies = ["m1", "m2", "m3", "m4", "m5"];
    for (const b of bodies) await send(q.url, b, "wallet-1", `dedup-${b}`);

    const received = await drain(sqs, q.url);
    expect(received.map((m) => m.Body)).toEqual(bodies);
  }, LONG_POLL_TEST_TIMEOUT_MS);

  test("MessageGroupId: grupo com mensagem em voo fica bloqueado; outro grupo segue", async () => {
    const q = await temp.fifo("spike-groups");
    await send(q.url, "A1", "group-A", "a1");
    await send(q.url, "A2", "group-A", "a2");

    const first = await receive(sqs, q.url, 1);
    expect(first.map((m) => m.Body)).toEqual(["A1"]);
    const a1 = first[0]!;

    await send(q.url, "B1", "group-B", "b1");

    // A1 em voo (não apagada): A2 NÃO pode ser entregue; B1 sim.
    const whileA1InFlight: string[] = [];
    for (let i = 0; i < 3 && !whileA1InFlight.includes("B1"); i++) {
      for (const m of await receive(sqs, q.url, 10)) {
        whileA1InFlight.push(m.Body ?? "");
        if (m.Body === "B1") await ack(sqs, q.url, m);
      }
    }
    expect(whileA1InFlight).toEqual(["B1"]);

    await ack(sqs, q.url, a1);
    const after = await drain(sqs, q.url);
    expect(after.map((m) => m.Body)).toEqual(["A2"]);
  }, LONG_POLL_TEST_TIMEOUT_MS);

  test("MessageDeduplicationId: reenvio com o mesmo id não gera segunda entrega", async () => {
    const q = await temp.fifo("spike-dedup");
    await send(q.url, "first", "wallet-1", "same-dedup-id");
    await send(q.url, "second", "wallet-1", "same-dedup-id");
    await send(q.url, "third", "wallet-1", "other-dedup-id");

    const received = await drain(sqs, q.url);
    expect(received.map((m) => m.Body)).toEqual(["first", "third"]);
  }, LONG_POLL_TEST_TIMEOUT_MS);

  test(
    "RedrivePolicy: após maxReceiveCount recebimentos sem ack, a mensagem vai para a DLQ",
    async () => {
      const maxReceiveCount = 2;
      const { main, dlq } = await temp.fifoWithDlq("spike-redrive", maxReceiveCount);
      await send(main.url, "poison", "wallet-1", "poison-1");

      const receiveCounts: string[] = [];
      for (let i = 0; i < maxReceiveCount + 3; i++) {
        const batch = await receive(sqs, main.url, 1);
        const m = batch[0];
        if (!m) break;
        expect(m.Body).toBe("poison");
        receiveCounts.push(m.Attributes?.ApproximateReceiveCount ?? "?");
        await nack(sqs, main.url, m);
      }

      // entregue exatamente maxReceiveCount vezes, com contagem crescente
      expect(receiveCounts).toEqual(["1", "2"]);

      const deadLettered = await drain(sqs, dlq.url);
      expect(deadLettered.map((m) => m.Body)).toEqual(["poison"]);
      expect(await drain(sqs, main.url, 1)).toHaveLength(0);
    },
    LONG_POLL_TEST_TIMEOUT_MS,
  );
});
