import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction, type WagerCommand } from "../../src/application/process-wager-transaction";
import { ResolvePendingReferences } from "../../src/application/resolve-pending-references";
import { Money } from "../../src/domain/money";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { errorText } from "../../src/infrastructure/logging/json-logger";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { initOrm, migrateUp, type Orm } from "../../src/infrastructure/persistence/orm";
import { SqlBackgroundStore } from "../../src/infrastructure/persistence/sql-background-store";
import { assertGlobalInvariants } from "../support/invariants";
import { createScratchDatabase } from "../support/postgres";
import { insertTx, inTransaction } from "../support/sql-fixtures";

const MAX = "999999999999999999.99";
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const ids = { next: () => randomUUID() };
let at = new Date();
const clock = { now: () => at };
let db: Awaited<ReturnType<typeof createScratchDatabase>>;
let orm: Orm;
let pool: Pool;
let uow: MikroOrmUnitOfWork;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  const config = loadConfig();
  db = await createScratchDatabase(config.databaseUrl);
  orm = await initOrm({ ...config, databaseUrl: db.url });
  await migrateUp(orm);
  pool = new Pool({ connectionString: db.url });
  uow = new MikroOrmUnitOfWork(orm, config.lockTimeoutMs);
  processWager = new ProcessWagerTransaction(uow, clock, ids);
});

afterAll(async () => { await pool?.end(); await orm?.close(true); await db?.drop(); });

async function fixture(balance = MAX): Promise<WagerCommand> {
  at = new Date();
  const playerId = ids.next();
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId, initialBalance: brl(balance), correlationId: ids.next() });
  const externalTransactionId = ids.next();
  return { walletId: wallet.id, playerId, providerId: "provider-a", externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`, roundId: "round-1", gameId: "game-1",
    kind: "BET", money: brl("1.00"), correlationId: ids.next() };
}

async function assertRejected(id: string, balance: string, events = ["WagerTransactionRejected"]): Promise<void> {
  expect((await pool.query("SELECT status, failure_code, result_balance_amount FROM wager_transactions WHERE id=$1", [id])).rows)
    .toEqual([{ status: "REJECTED", failure_code: "BALANCE_LIMIT_EXCEEDED", result_balance_amount: balance }]);
  expect((await pool.query("SELECT id FROM wallet_ledger_entries WHERE transaction_id=$1", [id])).rows).toEqual([]);
  expect((await pool.query("SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1 ORDER BY event_type", [id])).rows)
    .toEqual(events.map((event_type) => ({ event_type })));
}

test("crédito acima do teto rejeita com inbox/outbox atômicas e replay original após outro débito", async () => {
  const base = await fixture();
  const win = { ...base, kind: "WIN" as const };
  const delivery = { consumerName: "audit", messageId: ids.next() };
  const rejected = await processWager.execute(win, delivery);
  await assertRejected(rejected.transactionId!, MAX);
  expect((await pool.query("SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id=$1", [delivery.messageId])).rows)
    .toEqual([{ processed: true }]);
  const debit = { ...base, externalTransactionId: ids.next(), idempotencyKey: ids.next() };
  await processWager.execute(debit);
  expect((await processWager.execute(win, delivery)).balance?.toString()).toBe(MAX);
  expect((await processWager.execute(win)).idempotentReplay).toBe(true);
  expect((await pool.query("SELECT balance_amount, version FROM wallets WHERE id=$1", [win.walletId])).rows)
    .toEqual([{ balance_amount: "999999999999999998.99", version: 2 }]);
  await assertRejected(rejected.transactionId!, MAX);
  await assertGlobalInvariants(pool);
});

test("WIN pendente acima do teto não aborta a BET válida na resolução ansiosa", async () => {
  const bet = await fixture();
  const pending = await processWager.execute({ ...bet, kind: "WIN", externalTransactionId: ids.next(), idempotencyKey: ids.next(),
    money: brl(MAX), referenceExternalTransactionId: bet.externalTransactionId });
  expect(pending.status).toBe("PENDING_REFERENCE");
  const placed = await processWager.execute(bet);
  expect(placed.status).toBe("PROCESSED");
  expect(placed.balance?.toString()).toBe("999999999999999998.99");
  await assertRejected(pending.transactionId!, "999999999999999998.99", ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
  expect((await pool.query("SELECT direction FROM wallet_ledger_entries WHERE transaction_id=$1", [placed.transactionId])).rows)
    .toEqual([{ direction: "DEBIT" }]);
  await assertGlobalInvariants(pool);
});

test("worker terminaliza crédito pendente acima do teto com referência disponível e claim repetido é inócuo", async () => {
  const bet = await fixture();
  await processWager.execute(bet);
  // Estado de recuperação legítimo: pendência persistida e referência já confirmada.
  const pending = await inTransaction(pool, (sql) => insertTx(sql, { walletId: bet.walletId, playerId: bet.playerId, currency: "BRL" },
    { kind: "WIN", amount: MAX, status: "PENDING_REFERENCE", referenceExternalId: bet.externalTransactionId,
      nextReferenceAttemptAt: at }));
  const claim = (await new SqlBackgroundStore(uow).claimPending(at)).find((c) => c.transactionId === pending.id)!;
  expect(claim).toBeDefined();
  const resolver = new ResolvePendingReferences(uow, clock, ids);
  await resolver.execute(claim);
  await resolver.execute(claim);
  await assertRejected(pending.id, "999999999999999998.99");
  await assertGlobalInvariants(pool);
});

test("crédito que chega exatamente ao teto continua processado com valor exato", async () => {
  const base = await fixture("999999999999999999.98");
  const result = await processWager.execute({ ...base, kind: "WIN", money: brl("0.01") });
  expect(result.status).toBe("PROCESSED");
  expect(result.balance?.toString()).toBe(MAX);
  expect((await pool.query("SELECT balance_amount, version FROM wallets WHERE id=$1", [base.walletId])).rows)
    .toEqual([{ balance_amount: MAX, version: 2 }]);
  await assertGlobalInvariants(pool);
});

test("erro real do driver com dados financeiros tem diagnóstico sanitizado", async () => {
  const marker = JSON.stringify({ money: { amount: "987654321.23", currency: "BRL" } });
  let failure: unknown;
  try {
    await uow.withSql((sql) => sql.query("SELECT ?::numeric", [marker]));
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("987654321.23");
  expect(errorText(failure)).toBe("DATABASE_ERROR:22P02");
  await assertGlobalInvariants(pool);
});
