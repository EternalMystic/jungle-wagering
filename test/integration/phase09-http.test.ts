import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { initOrm, migrateUp } from "../../src/infrastructure/persistence/orm";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../../src/infrastructure/sqs/setup-queues";
import { createApp } from "../../src/interface/http/create-app";
import { ApiClient, bet, brl, openWalletViaApi, stringField } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";
import { createScratchDatabase } from "../support/postgres";
import { UNIT_OF_WORK } from "../../src/app.module";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { Money } from "../../src/domain/money";
import { NO_FAULTS } from "../../src/application/ports/fault-injector";
import { METRICS, PrometheusMetrics } from "../../src/infrastructure/metrics/prometheus-metrics";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { ObservedWagerProcessor } from "../../src/infrastructure/observed-wager-processor";
import { JsonLogger } from "../../src/infrastructure/logging/json-logger";
import { WagerQueueConsumer } from "../../src/interface/sqs/wager-consumer";
import { eventually } from "../support/cluster";

let app: INestApplication;
let db: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let sqs: SQSClient;
let queueUrls: string[] = [];
let api: ApiClient;

beforeAll(async () => {
  const config = loadConfig();
  db = await createScratchDatabase(config.databaseUrl);
  pool = new Pool({ connectionString: db.url });
  const orm = await initOrm({ ...config, databaseUrl: db.url });
  try { await migrateUp(orm); } finally { await orm.close(true); }
  const tag = randomUUID().slice(0, 8);
  const queues = { wagerTransactions: `phase09-${tag}.fifo`, wagerTransactionsDlq: `phase09-${tag}-dlq.fifo`, walletEvents: `phase09-${tag}-events.fifo` };
  sqs = createSqsClient(config.aws);
  const topology = await setupQueues(sqs, queues);
  queueUrls = Object.values(topology).map((q) => q.url);
  app = await createApp({ ...config, databaseUrl: db.url, queues, consumer: { ...config.consumer, enabled: false } }, { logger: false });
  await app.listen(0, "127.0.0.1");
  api = new ApiClient(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
});

afterAll(async () => {
  await app?.close();
  await Promise.allSettled(queueUrls.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
  sqs?.destroy();
  await pool?.end();
  await db?.drop();
});

async function fixture(initial = "100.00") {
  const playerId = randomUUID();
  const walletId = await openWalletViaApi(api, playerId, brl(initial));
  return { playerId, walletId };
}

test("ledger usa cursor opaco exclusivo por versão, inclui OPENING e permanece estável após novos commits", async () => {
  const { playerId, walletId } = await fixture();
  await api.submit(bet(walletId, playerId, randomUUID(), "1.00"));
  await api.submit(bet(walletId, playerId, randomUUID(), "2.00"));
  const first = await api.request("GET", `/wallets/${walletId}/ledger?limit=2`);
  expect(first.status).toBe(200);
  const page = first.body as { entries: { id: string; walletVersion: number; money: unknown; balanceAfter: unknown }[]; nextCursor: string };
  expect(page.entries.map((e) => e.walletVersion)).toEqual([1, 2]);
  expect(page.entries[0]).toMatchObject({ money: brl("100.00"), balanceAfter: brl("100.00") });
  expect(Buffer.from(page.nextCursor, "base64url").toString()).toBe("2");
  await api.submit(bet(walletId, playerId, randomUUID(), "3.00"));
  const next = await api.request("GET", `/wallets/${walletId}/ledger?limit=2&cursor=${page.nextCursor}`);
  expect(next.body).toMatchObject({ entries: [{ walletVersion: 3 }, { walletVersion: 4 }], nextCursor: null });
  const stored = (await pool.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id=$1 ORDER BY wallet_version", [walletId])).rows;
  expect([...page.entries, ...(next.body as typeof page).entries].map((e) => e.id)).toEqual(stored.map((e) => e.id));
  await assertGlobalInvariants(pool);
});

test("ledger valida cursor canônico/limite, isola wallets e retorna vazio para abertura zero", async () => {
  const { walletId } = await fixture("0.00");
  expect((await api.request("GET", `/wallets/${walletId}/ledger`)).body).toEqual({ entries: [], nextCursor: null });
  for (const query of ["cursor=%%%", "cursor=Mg==", "cursor=MA", "cursor=LTE", "cursor=OTAwNzE5OTI1NDc0MDk5Mg", "limit=0", "limit=101", "limit=1.5", "limit=2&limit=3"]) {
    const result = await api.request("GET", `/wallets/${walletId}/ledger?${query}`);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
  }
  for (const id of [randomUUID(), "invalid"]) {
    expect((await api.request("GET", `/wallets/${id}/ledger`)).status).toBe(404);
    expect((await api.request("POST", `/wallets/${id}/reconciliation`)).status).toBe(404);
  }
  await assertGlobalInvariants(pool);
});

test("GETs da §9 retornam o estado persistido e saldo original sem exigir autenticação", async () => {
  const { playerId, walletId } = await fixture();
  const command = bet(walletId, playerId, randomUUID(), "25.00");
  const submitted = await api.submit(command);
  const id = stringField(submitted.body, "transactionId");
  await api.submit(bet(walletId, playerId, randomUUID(), "10.00"));
  expect((await api.getWallet(walletId)).body).toMatchObject({ id: walletId, balance: brl("65.00"), version: 3 });
  const byId = await api.request("GET", `/wagering/transactions/${id}`);
  const byExternal = await api.request("GET", `/providers/${command.providerId}/wagering/transactions/${command.externalTransactionId}`);
  expect(byId.body).toEqual(byExternal.body);
  expect(byId.body).toMatchObject({ transactionId: id, status: "PROCESSED", money: brl("25.00"), balance: brl("75.00") });
  expect((await pool.query("SELECT result_balance_amount FROM wager_transactions WHERE id=$1", [id])).rows).toEqual([{ result_balance_amount: "75.00" }]);
  expect((await api.request("GET", `/providers/missing/wagering/transactions/${command.externalTransactionId}`)).status).toBe(404);
  await assertGlobalInvariants(pool);
});

test("reconciliação soma créditos menos débitos e não altera wallet, ledger ou outbox", async () => {
  const { playerId, walletId } = await fixture("999999999999999999.99");
  await api.submit(bet(walletId, playerId, randomUUID(), "0.01"));
  const before = (await pool.query("SELECT balance_amount, version FROM wallets WHERE id=$1", [walletId])).rows;
  const eventsBefore = (await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1", [walletId])).rows;
  const result = await api.request("POST", `/wallets/${walletId}/reconciliation`);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ walletId, storedBalance: brl("999999999999999999.98"), calculatedBalance: brl("999999999999999999.98"), difference: brl("0.00"), consistent: true, checkedEntries: 2 });
  expect((await pool.query("SELECT balance_amount, version FROM wallets WHERE id=$1", [walletId])).rows).toEqual(before);
  expect((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1", [walletId])).rows).toEqual(eventsBefore);
  expect((await pool.query("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id=$1", [walletId])).rows).toEqual([{ n: 2 }]);
  const zero = await fixture("0.00");
  expect((await api.request("POST", `/wallets/${zero.walletId}/reconciliation`)).body).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: brl("0.00") });
  await assertGlobalInvariants(pool);
});

test("divergência é sinalizada, logada com contexto e contada sem reparar nem expor valores", async () => {
  const { walletId } = await fixture("123456789.12");
  const client = await pool.connect();
  // Corrupção deliberada em banco descartável: somente o trigger de consistência da wallet.
  const triggers = (await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid='wallets'::regclass AND tgconstraint <> 0 AND NOT tgisinternal")).rows as { tgname: string }[];
  expect(triggers.length).toBeGreaterThan(0);
  const metricsBefore = await (await fetch(`${api.baseUrl}/metrics`)).text();
  const lines: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  try {
    await client.query("BEGIN");
    for (const { tgname } of triggers) await client.query(`ALTER TABLE wallets DISABLE TRIGGER "${tgname}"`);
    await client.query("UPDATE wallets SET balance_amount='123456788.12' WHERE id=$1", [walletId]);
    for (const { tgname } of triggers) await client.query(`ALTER TABLE wallets ENABLE TRIGGER "${tgname}"`);
    await client.query("COMMIT");
    const result = await api.request("POST", `/wallets/${walletId}/reconciliation`, { headers: { "x-correlation-id": "phase09-divergence" } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ consistent: false, storedBalance: brl("123456788.12"), calculatedBalance: brl("123456789.12"), difference: brl("-1.00"), checkedEntries: 1 });
    expect((await client.query("SELECT balance_amount FROM wallets WHERE id=$1", [walletId])).rows).toEqual([{ balance_amount: "123456788.12" }]);
    const metricsAfter = await (await fetch(`${api.baseUrl}/metrics`)).text();
    const count = (s: string) => Number.parseInt(/^reconciliation_divergences_total (\d+)/m.exec(s)?.[1] ?? "-1", 10);
    expect(count(metricsAfter)).toBe(count(metricsBefore) + 1);
    const logs = lines.flatMap((line) => line.trim().split("\n")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", walletId, correlationId: "phase09-divergence", msg: "wallet reconciliation divergence" }));
    expect(lines.join("")).not.toContain("123456789.12");
    expect(lines.join("")).not.toContain("123456788.12");
  } finally {
    write.mockRestore();
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    for (const { tgname } of triggers) await client.query(`ALTER TABLE wallets DISABLE TRIGGER "${tgname}"`);
    await client.query("UPDATE wallets SET balance_amount='123456789.12' WHERE id=$1", [walletId]);
    for (const { tgname } of triggers) await client.query(`ALTER TABLE wallets ENABLE TRIGGER "${tgname}"`);
    await client.query("COMMIT");
    client.release();
  }
  await assertGlobalInvariants(pool);
});

test("/metrics expõe D12 e conta decisões commitadas, replay HTTP e latência", async () => {
  const { playerId, walletId } = await fixture();
  const command = bet(walletId, playerId, randomUUID(), "1.00");
  await api.submit(command);
  await api.submit(command);
  await api.submit(bet(walletId, playerId, randomUUID(), "999.00"));
  const result = await fetch(`${api.baseUrl}/metrics`);
  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toContain("text/plain");
  const text = await result.text();
  for (const name of ["wager_transactions_total", "idempotent_replays_total", "inbox_duplicates_total", "sqs_retries_total", "sqs_dlq_total", "lock_conflicts_total", "outbox_lag_seconds", "wager_processing_seconds", "reconciliation_divergences_total"]) expect(text).toContain(`# HELP ${name} `);
  expect(text).toMatch(/wager_transactions_total\{status="PROCESSED",kind="BET"\} [1-9]/);
  expect(text).toMatch(/wager_transactions_total\{status="REJECTED",kind="BET"\} [1-9]/);
  expect(text).toMatch(/idempotent_replays_total\{channel="http"\} [1-9]/);
  expect(text).toMatch(/wager_processing_seconds_count [1-9]/);
  expect(text).not.toContain(walletId);
  expect((await pool.query("SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id=$1 AND kind='BET'", [walletId])).rows).toEqual([{ n: 2 }]);
  await assertGlobalInvariants(pool);
});

test("métricas observam commit: rollback não conta; pendência conta uma vez por mudança de status", async () => {
  const uow = app.get<MikroOrmUnitOfWork>(UNIT_OF_WORK);
  const metrics = app.get<PrometheusMetrics>(METRICS);
  const before = await metrics.registry.metrics();
  const ids = { next: randomUUID };
  const clock = { now: () => new Date() };
  const playerId = randomUUID();
  await expect(new OpenWallet({ run: (work) => uow.run(async (r) => { await work(r); throw new Error("rollback-probe"); }) }, clock, ids)
    .execute({ playerId, initialBalance: Money.from(brl("100.00")), correlationId: randomUUID() })).rejects.toThrow("rollback-probe");
  expect(await metrics.registry.metrics()).toBe(before);
  expect((await pool.query("SELECT id FROM wallets WHERE player_id=$1", [playerId])).rows).toEqual([]);
  const fixtureData = await fixture();
  const processor = new ObservedWagerProcessor(new ProcessWagerTransaction(uow, clock, ids), metrics);
  const ext = randomUUID();
  const refund = { ...fixtureData, providerId: "metrics-provider", externalTransactionId: randomUUID(), idempotencyKey: randomUUID(),
    roundId: "metrics-round", gameId: "metrics-game", kind: "REFUND" as const, money: Money.from(brl("1.00")), correlationId: randomUUID(), referenceExternalTransactionId: ext };
  const pending = await processor.execute(refund);
  await processor.execute(refund);
  await processor.execute({ ...refund, kind: "BET", externalTransactionId: ext, idempotencyKey: randomUUID(), referenceExternalTransactionId: undefined });
  const text = await metrics.registry.metrics();
  expect(text).toContain('wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"} 1');
  expect(text).toContain('wager_transactions_total{status="PROCESSED",kind="REFUND"} 1');
  expect((await pool.query("SELECT status FROM wager_transactions WHERE id=$1", [pending.transactionId])).rows).toEqual([{ status: "PROCESSED" }]);
  await assertGlobalInvariants(pool);
});

test("reconciliação lê snapshot confirmado sem esperar uma movimentação financeira ainda aberta", async () => {
  const { playerId, walletId } = await fixture();
  const uow = app.get<MikroOrmUnitOfWork>(UNIT_OF_WORK);
  let inserted!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { inserted = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const processor = new ProcessWagerTransaction({ run: (work) => uow.run(async (r) => {
    const result = await work(r); inserted(); await barrier; return result;
  }) }, { now: () => new Date() }, { next: randomUUID });
  const write = processor.execute({ ...bet(walletId, playerId, randomUUID(), "1.00"), kind: "BET", money: Money.from(brl("1.00")), idempotencyKey: randomUUID(), correlationId: randomUUID() });
  try {
    await ready;
    const result = await api.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(result.body).toMatchObject({ consistent: true, storedBalance: brl("100.00"), calculatedBalance: brl("100.00"), checkedEntries: 1 });
  } finally { release(); await write; }
  expect((await api.request("POST", `/wallets/${walletId}/reconciliation`)).body).toMatchObject({ consistent: true, storedBalance: brl("99.00"), calculatedBalance: brl("99.00"), checkedEntries: 2 });
  await assertGlobalInvariants(pool);
});

test("consumer real conta duplicata de inbox, retry por lock, conflito e envio à DLQ", async () => {
  const config = loadConfig();
  const uow = app.get<MikroOrmUnitOfWork>(UNIT_OF_WORK);
  const metrics = app.get<PrometheusMetrics>(METRICS);
  const { playerId, walletId } = await fixture();
  // Filas já existentes são exclusivas deste arquivo; a API está com consumer desativado.
  const queueName = queueUrls[0]!.split("/").at(-1)!;
  const dlqName = queueUrls[1]!.split("/").at(-1)!;
  const processor = new ObservedWagerProcessor(new ProcessWagerTransaction(uow, { now: () => new Date() }, { next: randomUUID }), metrics);
  const consumer = new WagerQueueConsumer({ sqs, queues: { ...config.queues, wagerTransactions: queueName, wagerTransactionsDlq: dlqName },
    config: { ...config.consumer, waitTimeSeconds: 1, retryBaseSeconds: 1, retryMaxSeconds: 1 },
    processWager: processor, metrics, faults: NO_FAULTS, logger: new JsonLogger("phase09-consumer"), generateId: randomUUID });
  const data = { ...bet(walletId, playerId, randomUUID(), "1.00"), idempotencyKey: randomUUID() };
  const message = { messageId: randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
  const send = (body: string) => sqs.send(new SendMessageCommand({ QueueUrl: queueUrls[0], MessageBody: body, MessageGroupId: walletId, MessageDeduplicationId: randomUUID() }));
  consumer.start();
  try {
    await send(JSON.stringify(message));
    await eventually("primeiro efeito confirmado", async () => (await pool.query("SELECT id FROM wager_transactions WHERE idempotency_key=$1", [data.idempotencyKey])).rows.length, (n) => n === 1, 3000);
    await send(JSON.stringify(message));
    await eventually("inbox duplicada observada", () => metrics.registry.metrics(), (text) => /^inbox_duplicates_total 1$/m.test(text), 3000);
    expect(await metrics.registry.metrics()).toContain('idempotent_replays_total{channel="sqs"} 1');
    await send("{");
    const dlq = await eventually("mensagem na DLQ", () => sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrls[1], WaitTimeSeconds: 1, MessageAttributeNames: ["All"] })), (res) => (res.Messages?.length ?? 0) > 0, 3000);
    expect(dlq.Messages?.[0]?.Body).toBe("{");
    await eventually("DLQ observada", () => metrics.registry.metrics(), (text) => /sqs_dlq_total\{reason="INVALID_JSON"\} 1/.test(text), 3000);
  } finally { await consumer.stop(); }

  // Timeout de lock real em UoW própria; consumidor usa o mesmo caminho de produção.
  const { initOrm: openOrm } = await import("../../src/infrastructure/persistence/orm");
  const orm = await openOrm({ ...config, databaseUrl: db.url });
  const shortUow = new MikroOrmUnitOfWork(orm, 50, metrics);
  // Um ReceiveMessage abortado pode continuar em voo no servidor: cada consumer tem filas próprias.
  const retryTag = randomUUID().slice(0, 8);
  const retryNames = { wagerTransactions: `phase09-retry-${retryTag}.fifo`, wagerTransactionsDlq: `phase09-retry-${retryTag}-dlq.fifo`, walletEvents: `phase09-retry-${retryTag}-events.fifo` };
  const retryQueues = await setupQueues(sqs, retryNames);
  queueUrls.push(...Object.values(retryQueues).map((q) => q.url));
  const blocking = await pool.connect();
  await blocking.query("BEGIN");
  await blocking.query("SELECT id FROM wallets WHERE id=$1 FOR UPDATE", [walletId]);
  const retryData = { ...data, externalTransactionId: randomUUID(), idempotencyKey: randomUUID() };
  const retryMessage = { ...message, messageId: randomUUID(), data: retryData };
  const retryConsumer = new WagerQueueConsumer({ sqs, queues: retryNames,
    config: { ...config.consumer, waitTimeSeconds: 1, retryBaseSeconds: 1, retryMaxSeconds: 1 },
    processWager: new ObservedWagerProcessor(new ProcessWagerTransaction(shortUow, { now: () => new Date() }, { next: randomUUID }), metrics),
    metrics, faults: NO_FAULTS, logger: new JsonLogger("phase09-retry"), generateId: randomUUID });
  retryConsumer.start();
  try {
    await sqs.send(new SendMessageCommand({ QueueUrl: retryQueues.wagerTransactions.url, MessageBody: JSON.stringify(retryMessage), MessageGroupId: walletId, MessageDeduplicationId: randomUUID() }));
    await eventually("lock e retry observados", () => metrics.registry.metrics(), (text) => /^lock_conflicts_total [1-9]/m.test(text) && /^sqs_retries_total [1-9]/m.test(text), 3000);
    expect((await pool.query("SELECT id FROM wager_transactions WHERE idempotency_key=$1", [retryData.idempotencyKey])).rows).toEqual([]);
    await blocking.query("ROLLBACK");
    await eventually("retry confirma após liberar lock", async () => (await pool.query("SELECT status FROM wager_transactions WHERE idempotency_key=$1", [retryData.idempotencyKey])).rows, (rows) => rows[0]?.status === "PROCESSED", 3000);
    expect((await pool.query("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id=$1", [walletId])).rows).toEqual([{ n: 3 }]);
  } finally {
    await blocking.query("ROLLBACK"); blocking.release();
    await retryConsumer.stop(); await orm.close(true);
  }
  await assertGlobalInvariants(pool);
}, 15_000);
