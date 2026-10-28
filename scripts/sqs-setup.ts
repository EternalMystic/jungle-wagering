#!/usr/bin/env bun
/**
 * Cria as filas do projeto no emulador SQS (idempotente):
 *   wager-transactions.fifo  → RedrivePolicy maxReceiveCount=5 → wager-transactions-dlq.fifo
 *   wallet-events.fifo       (eventos publicados pela outbox)
 */
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/infrastructure/config/app-config";
import { createSqsClient } from "../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../src/infrastructure/sqs/setup-queues";

const config = loadConfig();
const sqs = createSqsClient(config.aws);

// O healthcheck do compose garante a porta aberta; aqui esperamos a API SQS responder
// (prazo fixo, falha explícita se o emulador não subir).
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await sqs.send(new ListQueuesCommand({}));
    break;
  } catch (error) {
    if (Date.now() > deadline) {
      console.error(`emulador SQS em ${config.aws.endpoint} não respondeu em 30s:`, error);
      process.exit(1);
    }
    await Bun.sleep(500);
  }
}

try {
  const topology = await setupQueues(sqs, config.queues);
  for (const q of [topology.wagerTransactions, topology.wagerTransactionsDlq, topology.walletEvents]) {
    const redrive = q.attributes.RedrivePolicy ? ` redrive=${q.attributes.RedrivePolicy}` : "";
    console.log(`✔ ${q.name} fifo=${q.attributes.FifoQueue} url=${q.url}${redrive}`);
  }
} catch (error) {
  console.error("sqs:setup falhou:", error);
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
