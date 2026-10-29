import { afterAll, beforeAll, expect, test } from "bun:test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction, type WagerCommand } from "../../src/application/process-wager-transaction";
import { ResolvePendingReferences, REFERENCE_TTL_MS } from "../../src/application/resolve-pending-references";
import { NO_FAULTS, FaultPoint } from "../../src/application/ports/fault-injector";
import { Money } from "../../src/domain/money";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { initOrm, migrateUp, type Orm } from "../../src/infrastructure/persistence/orm";
import { SqlBackgroundStore } from "../../src/infrastructure/persistence/sql-background-store";
import { OutboxPublisher } from "../../src/infrastructure/workers/outbox-publisher";
import { BackgroundWorkers } from "../../src/infrastructure/workers/background-workers";
import { OutboxMetricsController } from "../../src/interface/http/outbox-metrics.controller";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { assertGlobalInvariants } from "../support/invariants";
import { createScratchDatabase } from "../support/postgres";
import { TempQueues, drain } from "../support/sqs";
import { eventually } from "../support/cluster";
import { launchTogether } from "../support/concurrency";

const config = loadConfig();
const sqs = createSqsClient(config.aws);
const queues = new TempQueues(sqs);
const ids = { next: () => randomUUID() };
const logger = { info() {}, warn() {}, error() {} };
let at = new Date();
const clock = { now: () => at };
let db: Awaited<ReturnType<typeof createScratchDatabase>>;
let orm: Orm;
let pool: Pool;
let uow: MikroOrmUnitOfWork;
let store: SqlBackgroundStore;
let processWager: ProcessWagerTransaction;
let resolver: ResolvePendingReferences;

beforeAll(async () => {
  db = await createScratchDatabase(config.databaseUrl);
  orm = await initOrm({ ...config, databaseUrl: db.url });
  await migrateUp(orm);
  pool = new Pool({ connectionString: db.url });
  uow = new MikroOrmUnitOfWork(orm, config.lockTimeoutMs);
  store = new SqlBackgroundStore(uow);
  processWager = new ProcessWagerTransaction(uow, clock, ids);
  resolver = new ResolvePendingReferences(uow, clock, ids);
});

afterAll(async () => {
  await queues.dispose();
  sqs.destroy();
  await pool?.end();
  await orm?.close(true);
  await db?.drop();
});

async function fixture(): Promise<WagerCommand> {
  at = new Date();
  const playerId = ids.next();
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), correlationId: ids.next() });
  const externalTransactionId = ids.next();
  return { walletId: wallet.id, playerId, providerId: "provider-a", externalTransactionId, idempotencyKey: `provider-a:${externalTransactionId}`, roundId: ids.next(), gameId: "game", kind: "BET", money: Money.from({ amount: "30.00", currency: "BRL" }), correlationId: ids.next() };
}

function refund(bet: WagerCommand): WagerCommand {
  const externalTransactionId = ids.next();
  return { ...bet, externalTransactionId, idempotencyKey: `provider-a:${externalTransactionId}`, kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId };
}

test("resolução ansiosa é atômica; BET responde seu saldo original, REFUND termina no mesmo commit", async () => {
  const bet = await fixture();
  const pending = await processWager.execute(refund(bet));
  expect(pending.status).toBe("PENDING_REFERENCE");
  const placed = await processWager.execute(bet);
  expect(placed.balance?.toString()).toBe("70.00");
  const resolved = await uow.run((r) => r.transactions.findById(pending.transactionId!));
  expect(resolved?.status).toBe("PROCESSED");
  expect(resolved?.resultBalance?.toString()).toBe("100.00");
  expect((await processWager.execute(bet)).balance?.toString()).toBe("70.00");
  await assertGlobalInvariants(pool);
});

test("worker usa backoff persistente e TTL com clock injetado; rejeição emite evento sem ledger", async () => {
  const bet = await fixture();
  const pending = await processWager.execute(refund(bet));
  at = new Date(at.getTime() + 5000);
  const claims = await store.claimPending(at, 50);
  expect(claims.map((c) => c.transactionId)).toContain(pending.transactionId!);
  for (const claim of claims) await resolver.execute(claim);
  const retried = await uow.run((r) => r.transactions.findById(pending.transactionId!));
  expect(retried?.referenceAttempts).toBe(1);
  expect(retried?.nextReferenceAttemptAt?.getTime()).toBe(at.getTime() + 10_000);
  at = new Date(at.getTime() + REFERENCE_TTL_MS);
  for (const claim of await store.claimPending(at, 50)) await resolver.execute(claim);
  const expired = await uow.run((r) => r.transactions.findById(pending.transactionId!));
  expect(expired?.status).toBe("REJECTED");
  expect(expired?.failureCode).toBe("REFERENCE_NOT_FOUND");
  expect((await pool.query("SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1 ORDER BY event_type", [pending.transactionId])).rows).toEqual([{ event_type: "WagerTransactionPendingReference" }, { event_type: "WagerTransactionRejected" }]);
  expect((await pool.query("SELECT id FROM wallet_ledger_entries WHERE transaction_id=$1", [pending.transactionId])).rows).toEqual([]);
  await assertGlobalInvariants(pool);
});

test("publisher publica envelope confirmado no SQS real e preserva dono; lag zera", async () => {
  await fixture();
  const queue = await queues.fifo("background-events");
  const publisher = new OutboxPublisher(store, sqs, queue.url, "publisher-test", NO_FAULTS, logger);
  expect(await store.lagSeconds()).toBeGreaterThanOrEqual(0);
  while (await publisher.tick()) { /* drena o backlog confirmado */ }
  const events = await drain(sqs, queue.url);
  const rows = (await pool.query("SELECT id, payload, locked_by FROM outbox_messages WHERE published_at IS NOT NULL")).rows;
  expect(new Set(events.map((e) => JSON.parse(e.Body!).eventId))).toEqual(new Set(rows.map((r) => r.id)));
  for (const event of events) {
    const envelope = JSON.parse(event.Body!);
    expect(envelope).toEqual(rows.find((r) => r.id === envelope.eventId)?.payload);
  }
  expect(rows.every((r) => r.locked_by === "publisher-test")).toBe(true);
  expect(await store.lagSeconds()).toBe(0);
  await assertGlobalInvariants(pool);
}, 30_000);

test("SKIP LOCKED pula evento disputado; claims concorrentes são disjuntos e dono antigo não pode marcar", async () => {
  await fixture();
  const blocker = await pool.connect();
  let lockedId: string;
  try {
    await blocker.query("BEGIN");
    lockedId = (await blocker.query("SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT 1 FOR UPDATE")).rows[0].id;
    const claims = (await launchTogether(2, (i) => store.claimOutbox(i === 0 ? "owner-a" : "owner-b", 1))).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message.id).not.toBe(lockedId);
    await blocker.query("COMMIT");
    const old = (await store.claimOutbox("old-owner", 1))[0]!;
    expect(old.message.id).toBe(lockedId);
    expect(await store.claimOutbox("thief", 50)).toEqual([]);
    await pool.query("UPDATE outbox_messages SET locked_until = clock_timestamp() - interval '1 second' WHERE id = $1", [old.message.id]);
    const fresh = (await store.claimOutbox("new-owner", 1))[0]!;
    expect(fresh.message.id).toBe(old.message.id);
    expect(await store.renew(old)).toBeUndefined();
    expect(await store.finish(old)).toBe(false);
    expect((await pool.query("SELECT published_at FROM outbox_messages WHERE id=$1", [fresh.message.id])).rows[0].published_at).toBeNull();
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  // Libera os leases dos componentes que só reivindicaram, sem publicar.
  await pool.query("UPDATE outbox_messages SET locked_until = clock_timestamp() - interval '1 second' WHERE published_at IS NULL AND locked_by IS NOT NULL");
  await assertGlobalInvariants(pool);
});

test("publish falhando persiste backoff sem descarte; evento não confirmado nunca é visível", async () => {
  const bet = await fixture();
  const failed = new OutboxPublisher(store, sqs, "http://localhost:4566/000000000000/nonexistent.fifo", "failed-publisher", NO_FAULTS, logger);
  await failed.tick();
  const failures = (await pool.query("SELECT attempts, last_error, published_at, locked_by, next_attempt_at > occurred_at AS delayed FROM outbox_messages WHERE locked_by IS NULL AND attempts > 0")).rows;
  expect(failures.length).toBeGreaterThan(0);
  expect(failures.every((r) => r.attempts === 1 && r.last_error === "SQS_PUBLISH_FAILED" && r.published_at === null && r.delayed)).toBe(true);
  const queue = await queues.fifo("uncommitted-events");
  const publisher = new OutboxPublisher(store, sqs, queue.url, "visible-publisher", NO_FAULTS, logger);
  let release!: () => void;
  let inserted!: () => void;
  const ready = new Promise<void>((r) => { inserted = r; });
  const wait = new Promise<void>((r) => { release = r; });
  const id = ids.next();
  const tx = uow.withSql(async (sql) => {
    await sql.query("INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, next_attempt_at) VALUES (?, ?, 'Probe', 1, ?::jsonb, ?, ?)", [id, bet.walletId, JSON.stringify({ eventId: id }), new Date(), new Date()]);
    inserted();
    await wait;
    throw new Error("abort-uncommitted-probe");
  });
  const rolledBack = tx.catch((error: unknown) => error);
  try {
    await ready;
    await publisher.tick();
    expect((await drain(sqs, queue.url)).map((m) => JSON.parse(m.Body!).eventId)).not.toContain(id);
  } finally { release(); }
  expect(await rolledBack).toBeInstanceOf(Error);
  const rollbackError = await rolledBack;
  if (!(rollbackError instanceof Error)) throw new Error("probe did not roll back");
  expect(rollbackError.message).toBe("abort-uncommitted-probe");
  expect((await pool.query("SELECT id FROM outbox_messages WHERE id=$1", [id])).rows).toEqual([]);
  const metric = await new OutboxMetricsController(store).metricsText();
  expect(metric).toContain("# TYPE outbox_lag_seconds gauge");
  expect(metric).toMatch(/outbox_lag_seconds [0-9]/);
  await assertGlobalInvariants(pool);
}, 30_000);

test("after-publish-before-mark deixa evento recuperável por outro dono com o mesmo eventId", async () => {
  await fixture();
  await pool.query("UPDATE outbox_messages SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE published_at IS NULL");
  const queue = await queues.fifo("recover-events");
  const faults = { checkpoint(point: string) { if (point === FaultPoint.AfterPublishBeforeMark) throw new Error("interrupted-after-send"); } };
  const broken = new OutboxPublisher(store, sqs, queue.url, "dead-publisher", faults, logger);
  await expect(broken.tick()).rejects.toThrow("interrupted-after-send");
  const before = await drain(sqs, queue.url);
  expect(before).toHaveLength(1);
  const sentId = JSON.parse(before[0]!.Body!).eventId;
  expect((await pool.query("SELECT published_at FROM outbox_messages WHERE id=$1", [sentId])).rows[0].published_at).toBeNull();
  await pool.query("UPDATE outbox_messages SET locked_until = clock_timestamp() - interval '1 second' WHERE published_at IS NULL AND locked_by IS NOT NULL");
  const recovered = new OutboxPublisher(store, sqs, queue.url, "recovered-publisher", NO_FAULTS, logger);
  while (await recovered.tick()) { /* todos os eventos confirmados têm destino */ }
  expect((await pool.query("SELECT published_at IS NOT NULL AS published, locked_by FROM outbox_messages WHERE id=$1", [sentId])).rows).toEqual([{ published: true, locked_by: "recovered-publisher" }]);
  await assertGlobalInvariants(pool);
}, 30_000);

test("REFUND e ROLLBACK pendentes disputam uma única reversão; cadeias resolvem no mesmo commit", async () => {
  const bet = await fixture();
  const first = refund(bet);
  const second = { ...refund(bet), kind: "ROLLBACK" as const };
  const [a, b] = await Promise.all([processWager.execute(first), processWager.execute(second)]);
  expect([a.status, b.status]).toEqual(["PENDING_REFERENCE", "PENDING_REFERENCE"]);
  await processWager.execute(bet);
  const states = (await pool.query("SELECT status, failure_code FROM wager_transactions WHERE id = ANY($1::uuid[])", [[a.transactionId, b.transactionId]])).rows;
  expect(states.map((r) => r.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect(states.find((r) => r.status === "REJECTED")?.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
  const root = await fixture();
  const mid = refund(root);
  const child = { ...refund(mid), kind: "ROLLBACK" as const };
  const c = await processWager.execute(child);
  await processWager.execute(mid);
  await processWager.execute(root);
  expect((await uow.run((r) => r.transactions.findById(c.transactionId!)))?.status).toBe("PROCESSED");
  await assertGlobalInvariants(pool);
});

test("falha before-commit desfaz BET, resolução ansiosa, ledger, inbox e outbox juntos", async () => {
  const bet = await fixture();
  const pending = await processWager.execute(refund(bet));
  const before = (await pool.query("SELECT count(*)::integer AS n FROM outbox_messages")).rows[0].n;
  const interrupted = new ProcessWagerTransaction(uow, clock, ids, { checkpoint() { throw new Error("abort-entire-commit"); } });
  const messageId = ids.next();
  await expect(interrupted.execute(bet, { consumerName: "atomic-test", messageId })).rejects.toThrow("abort-entire-commit");
  expect((await uow.run((r) => r.transactions.findById(pending.transactionId!)))?.status).toBe("PENDING_REFERENCE");
  expect((await pool.query("SELECT balance_amount FROM wallets WHERE id=$1", [bet.walletId])).rows[0].balance_amount).toBe("100.00");
  expect((await pool.query("SELECT count(*)::integer AS n FROM outbox_messages")).rows[0].n).toBe(before);
  expect((await pool.query("SELECT * FROM inbox_messages WHERE message_id=$1", [messageId])).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM wager_transactions WHERE idempotency_key=$1", [bet.idempotencyKey])).rows).toEqual([]);
  expect((await pool.query("SELECT direction FROM wallet_ledger_entries WHERE wallet_id=$1", [bet.walletId])).rows).toEqual([{ direction: "CREDIT" }]);
  await assertGlobalInvariants(pool);
});

test("oitava tentativa rejeita sem duplicar eventos; claim velho não consome tentativa nova", async () => {
  const bet = await fixture();
  const pending = await processWager.execute(refund(bet));
  at = new Date(at.getTime() + 5000);
  const original = (await store.claimPending(at, 50)).find((c) => c.transactionId === pending.transactionId)!;
  at = new Date(at.getTime() + 30_000);
  const fresh = (await store.claimPending(at, 50)).find((c) => c.transactionId === pending.transactionId)!;
  await resolver.execute(original);
  expect((await uow.run((r) => r.transactions.findById(pending.transactionId!)))?.referenceAttempts).toBe(0);
  await resolver.execute(fresh);
  for (let attempt = 2; attempt <= 8; attempt++) {
    const tx = await uow.run((r) => r.transactions.findById(pending.transactionId!));
    at = tx!.nextReferenceAttemptAt!;
    const claim = (await store.claimPending(at, 50)).find((c) => c.transactionId === pending.transactionId)!;
    await resolver.execute(claim);
    await resolver.execute(claim);
  }
  const final = await uow.run((r) => r.transactions.findById(pending.transactionId!));
  expect(final?.referenceAttempts).toBe(8);
  expect(final?.failureCode).toBe("REFERENCE_NOT_FOUND");
  expect((await pool.query("SELECT id FROM outbox_messages WHERE event_type='WagerTransactionRejected' AND payload->'data'->>'transactionId'=$1", [pending.transactionId])).rows).toHaveLength(1);
  await assertGlobalInvariants(pool);
});

test("worker revalida escopo sob lock da wallet: referência de outra wallet não credita", async () => {
  const source = await fixture();
  const other = await fixture();
  const early = await processWager.execute({ ...refund(other), referenceExternalTransactionId: source.externalTransactionId });
  await processWager.execute(source);
  expect((await uow.run((r) => r.transactions.findById(early.transactionId!)))?.status).toBe("PENDING_REFERENCE");
  at = new Date(at.getTime() + 5000);
  const claim = (await store.claimPending(at, 50)).find((c) => c.transactionId === early.transactionId)!;
  await resolver.execute(claim);
  const result = await uow.run((r) => r.transactions.findById(early.transactionId!));
  expect(result?.failureCode).toBe("REFERENCE_SCOPE_MISMATCH");
  expect((await pool.query("SELECT balance_amount FROM wallets WHERE id=$1", [other.walletId])).rows[0].balance_amount).toBe("100.00");
  await assertGlobalInvariants(pool);
});

test("agendamento inicia os dois laços, publica e reagenda pendência; stop conclui o trabalho", async () => {
  const bet = await fixture();
  const pending = await processWager.execute(refund(bet));
  await pool.query("UPDATE wager_transactions SET next_reference_attempt_at = clock_timestamp() - interval '1 second' WHERE id=$1", [pending.transactionId]);
  const queue = await queues.fifo("scheduled-events");
  const workers = new BackgroundWorkers(store, new ResolvePendingReferences(uow, { now: () => new Date() }, ids), sqs,
    queue.url.split("/").at(-1)!, "scheduled-owner", NO_FAULTS, logger);
  try {
    workers.start();
    await eventually("laços de pendências e publisher executaram", async () => {
      const tx = await uow.run((r) => r.transactions.findById(pending.transactionId!));
      const published = (await pool.query("SELECT count(*)::integer AS n FROM outbox_messages WHERE locked_by='scheduled-owner' AND published_at IS NOT NULL")).rows[0].n;
      return { attempts: tx?.referenceAttempts, published };
    }, (state) => state.attempts === 1 && state.published > 0, 5000);
  } finally { await workers.stop(); }
  expect((await drain(sqs, queue.url)).length).toBeGreaterThan(0);
  await assertGlobalInvariants(pool);
}, 15_000);
