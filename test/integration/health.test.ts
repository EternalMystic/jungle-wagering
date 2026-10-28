/**
 * /health/live e /health/ready com a aplicação Nest REAL falando com o PostgreSQL e o
 * emulador SQS do docker-compose (nada mockado).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type AppConfig, loadConfig } from "../../src/infrastructure/config/app-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../../src/infrastructure/sqs/setup-queues";
import { createApp } from "../../src/interface/http/create-app";
import { query } from "../support/postgres";

const config = loadConfig();
const opened: INestApplication[] = [];
let sqs: SQSClient;

async function start(cfg: AppConfig): Promise<string> {
  const app = await createApp(cfg, { logger: false });
  opened.push(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  sqs = createSqsClient(config.aws);
  await setupQueues(sqs, config.queues);
});

afterAll(async () => {
  await Promise.allSettled(opened.map((app) => app.close()));
  sqs.destroy();
});

describe("health", () => {
  test("GET /health/live responde 200 sem tocar em dependências", async () => {
    const url = await start(config);
    const res = await fetch(`${url}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready = 200 com Postgres (SELECT 1) e SQS (GetQueueUrl) alcançáveis", async () => {
    // pré-condição verificada por fora da aplicação: banco e fila existem de fato
    const rows = await query<{ ok: number }>(config.databaseUrl, "SELECT 1 AS ok");
    expect(rows).toEqual([{ ok: 1 }]);

    const url = await start(config);
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
  });

  test("GET /health/ready = 503 quando a fila de entrada não existe (GetQueueUrl falha)", async () => {
    const missing = `missing-${randomUUID().slice(0, 8)}.fifo`;
    const url = await start({ ...config, queues: { ...config.queues, wagerTransactions: missing } });
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe("unavailable");
    expect(body.checks).toEqual({ postgres: "up", sqs: "down" });
  });
});
