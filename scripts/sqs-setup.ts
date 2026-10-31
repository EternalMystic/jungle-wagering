#!/usr/bin/env bun
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/infrastructure/config/app-config";
import { createSqsClient } from "../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../src/infrastructure/sqs/setup-queues";

const cfg = loadConfig();
const sqs = createSqsClient(cfg.aws);


// Porta aberta ainda nao quer dizer que o emulador acordou.
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await sqs.send(new ListQueuesCommand({}));
    break;
  } catch (err) {
    if (Date.now() > deadline) {
      console.error(`emulador SQS em ${cfg.aws.endpoint} não respondeu em 30s:`, err);
      process.exit(1);
    }
    await Bun.sleep(500);
  }
}

try {
  const topology = await setupQueues(sqs, cfg.queues);
  for (const q of [topology.wagerTransactions, topology.wagerTransactionsDlq, topology.walletEvents]) {
    const redrive = q.attributes.RedrivePolicy ? ` redrive=${q.attributes.RedrivePolicy}` : "";
    console.log(`✔ ${q.name} fifo=${q.attributes.FifoQueue} url=${q.url}${redrive}`);
  }
} catch (err) {
  console.error("sqs:setup falhou:", err);
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
