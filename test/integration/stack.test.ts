/**
 * Spike do stack contra Postgres 16 e emulador SQS REAIS (docker-compose):
 *   - conexão e versão do Postgres;
 *   - Migrator do MikroORM programático sob Bun: round-trip up → down → up num banco
 *     descartável (não mexe no banco `wagering` usado pelos portões);
 *   - Nest de pé: /health/live e /health/ready (SELECT 1 + GetQueueUrl), incluindo o 503.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import type { AddressInfo } from "node:net";
import { type AppConfig, loadConfig } from "../../src/infrastructure/config/app-config";
import { MIGRATIONS_TABLE } from "../../src/infrastructure/persistence/mikro-orm.config";
import { initOrm, migrateDown, migrateUp } from "../../src/infrastructure/persistence/orm";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../../src/infrastructure/sqs/setup-queues";
import { createApp } from "../../src/interface/http/create-app";

const config = loadConfig();

function withDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: withDatabase(config.databaseUrl, "postgres") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("Postgres real", () => {
  test("responde SELECT 1 e é a versão 16", async () => {
    const c = new Client({ connectionString: config.databaseUrl });
    await c.connect();
    try {
      const one = await c.query<{ ok: number }>("select 1 as ok");
      expect(one.rows).toEqual([{ ok: 1 }]);
      const version = await c.query<{ server_version: string }>("show server_version");
      expect(version.rows[0]?.server_version).toStartWith("16.");
    } finally {
      await c.end();
    }
  });
});

describe("Migrator do MikroORM sob Bun (programático)", () => {
  const dbName = `wagering_it_${Date.now()}_${process.pid}`;
  let isolated: AppConfig;

  beforeAll(async () => {
    await admin((c) => c.query(`create database "${dbName}"`));
    isolated = { ...config, databaseUrl: withDatabase(config.databaseUrl, dbName) };
  });

  afterAll(async () => {
    await admin((c) => c.query(`drop database if exists "${dbName}" with (force)`));
  });

  async function executedInDb(): Promise<string[]> {
    const c = new Client({ connectionString: isolated.databaseUrl });
    await c.connect();
    try {
      const res = await c.query<{ name: string }>(`select name from "${MIGRATIONS_TABLE}" order by id`);
      return res.rows.map((r) => r.name);
    } finally {
      await c.end();
    }
  }

  test("round-trip up → down → up registra e remove a migration inicial", async () => {
    const orm = await initOrm(isolated);
    try {
      const up1 = await migrateUp(orm);
      expect(up1.applied).toEqual(["Migration20261028000000_initial"]);
      expect(await executedInDb()).toEqual(["Migration20261028000000_initial"]);

      const again = await migrateUp(orm);
      expect(again.applied).toEqual([]);

      const down = await migrateDown(orm);
      expect(down.applied).toEqual(["Migration20261028000000_initial"]);
      expect(await executedInDb()).toEqual([]);

      const up2 = await migrateUp(orm);
      expect(up2.applied).toEqual(["Migration20261028000000_initial"]);
      expect(await executedInDb()).toEqual(["Migration20261028000000_initial"]);
    } finally {
      await orm.close(true);
    }
  }, 30_000);
});

async function startApp(cfg: AppConfig): Promise<{ app: INestApplication; base: string }> {
  const app = await createApp(cfg, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${address.port}` };
}

describe("HTTP health (Nest sob Bun, dependências reais)", () => {
  let healthy: { app: INestApplication; base: string };
  let missingQueue: { app: INestApplication; base: string };

  beforeAll(async () => {
    const sqs = createSqsClient(config.aws);
    try {
      await setupQueues(sqs, config.queues);
    } finally {
      sqs.destroy();
    }
    healthy = await startApp(config);
    missingQueue = await startApp({
      ...config,
      queues: { ...config.queues, wagerTransactions: `missing-${Date.now()}.fifo` },
    });
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([healthy?.app.close(), missingQueue?.app.close()]);
  });

  test("GET /health/live → 200 sem tocar em dependências", async () => {
    const res = await fetch(`${healthy.base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready → 200 com Postgres e SQS alcançáveis", async () => {
    const res = await fetch(`${healthy.base}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
  });

  test("GET /health/ready → 503 quando a fila de entrada não existe no SQS", async () => {
    const res = await fetch(`${missingQueue.base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", checks: { postgres: "up", sqs: "down" } });
  });
});
