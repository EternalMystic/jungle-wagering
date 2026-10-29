/**
 * §13 Concorrência 1, 2 e 3 — paralelismo REAL entre PROCESSOS: 3 instâncias da aplicação
 * (`Bun.spawn`), mesmo banco, requisições distribuídas entre elas. A sobreposição é PROVADA
 * no Postgres (`contend`: N backends bloqueados no lock da wallet ao mesmo tempo), não
 * inferida do relógio do cliente. Todo teste confere o banco e termina com as invariantes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { Cluster } from "../support/cluster";
import { StartBarrier, contend, countLockWaiters, launchTogether, maxInFlight } from "../support/concurrency";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { ledgerOf, outboxEventTypes, transactionByKey, transactionsOf, walletState } from "../support/db-queries";
import { type HttpResult, asRecord, bet, brl, newPlayerId, openWalletViaApi, stringField } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

const INSTANCES = 3;

let db: IsolatedDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_http");
  cluster = await Cluster.start({ databaseUrl: db.url, tag: "conchttp", instances: INSTANCES });
}, 120_000);

afterAll(async () => {
  await cluster?.dispose();
  await db?.drop();
}, 60_000);

function holdWallets(...walletIds: string[]) {
  return async (c: PoolClient): Promise<void> => {
    const res = await c.query("SELECT id FROM wallets WHERE id = ANY($1::uuid[]) FOR UPDATE", [walletIds]);
    if (res.rowCount !== walletIds.length) throw new Error(`wallets ${walletIds.join(",")} não existem todas`);
  };
}

const field = (r: HttpResult, name: string): unknown => asRecord(r.body)[name];
const balanceOf = (r: HttpResult): unknown => asRecord(field(r, "balance"), "balance").amount;

describe("§13 concorrência — HTTP em 3 processos", () => {
  test("1. a mesma BET 50× em paralelo, espalhada por 3 instâncias → um único débito", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("1000.00"));
    const body = bet(walletId, player, "bet-50x", "10.00");

    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: holdWallets(walletId),
      expectedWaiters: 50,
      run: () => launchTogether(50, (i) => cluster.api(i).submit(body)),
    });

    // as 50 estiveram DENTRO do banco esperando o lock ao mesmo tempo: nenhuma instância
    // sozinha tem 50 (≈17 por processo), logo os 3 processos disputaram juntos
    expect(maxWaiters).toBeGreaterThanOrEqual(50);
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(200));
    expect(results.filter((r) => field(r, "idempotentReplay") === false)).toHaveLength(1);
    expect(new Set(results.map((r) => field(r, "transactionId"))).size).toBe(1);
    expect(new Set(results.map(balanceOf))).toEqual(new Set(["990.00"]));

    const tx = await transactionByKey(db.pool, "provider-a:bet-50x");
    expect(tx).toMatchObject({ status: "PROCESSED", result_balance_amount: "990.00" });
    const debits = (await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT");
    expect(debits).toEqual([{ transaction_id: tx?.id ?? "", direction: "DEBIT", amount: "10.00", balance_after: "990.00", wallet_version: 2 }]);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "990.00", version: 2 });
    expect(await outboxEventTypes(db.pool, tx?.id ?? "")).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await assertGlobalInvariants(db.pool);
  }, 60_000);

  test("2. §8 — 100.00 e duas BETs de 80.00 em instâncias diferentes → [200, 422], saldo 20.00, 1 débito; retries não duplicam", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(1), player, brl("100.00"));
    const bodies = [bet(walletId, player, "bet-a", "80.00"), bet(walletId, player, "bet-b", "80.00")];

    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: holdWallets(walletId),
      expectedWaiters: 2,
      run: () => launchTogether(2, (i) => cluster.api(i).submit(bodies[i] ?? bodies[0]!)),
    });
    expect(maxWaiters).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const winner = results.find((r) => r.status === 200)!;
    const loser = results.find((r) => r.status === 422)!;
    expect(balanceOf(winner)).toBe("20.00");
    expect(asRecord(loser.body)).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: brl("20.00") });

    // retries das duas keys, em paralelo, pela TERCEIRA instância e pelas outras
    const retries = await launchTogether(12, (i) => cluster.api(i).submit(bodies[i % 2]!));
    for (const [i, r] of retries.entries()) {
      const original = results[i % 2]!;
      expect(r.status).toBe(original.status);
      expect(asRecord(r.body)).toMatchObject({
        transactionId: field(original, "transactionId"),
        status: field(original, "status"),
        balance: field(original, "balance"),
        idempotentReplay: true,
      });
    }

    const debits = (await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]?.transaction_id).toBe(stringField(winner.body, "transactionId"));
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "20.00", version: 2 });
    const rejected = (await transactionsOf(db.pool, walletId)).filter((t) => t.status === "REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ failure_code: "INSUFFICIENT_FUNDS", result_balance_amount: "20.00" });
    await assertGlobalInvariants(db.pool);
  }, 60_000);

  test("3. wallets distintas em paralelo: com UMA wallet travada, as outras 29 terminam (sem lock global)", async () => {
    const WALLETS = 30;
    const players = Array.from({ length: WALLETS }, () => newPlayerId());
    const walletIds = await Promise.all(players.map((p, i) => openWalletViaApi(cluster.api(i), p, brl("100.00"))));
    const blocked = walletIds[0]!;

    const holder = await db.pool.connect();
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? -1;
      await holder.query("BEGIN");
      await holdWallets(blocked)(holder);

      const barrier = new StartBarrier(WALLETS);
      const requests = walletIds.map(async (walletId, i) => {
        await barrier.arrive();
        return cluster.api(i).submit(bet(walletId, players[i]!, `bet-w${i}`, "10.00"));
      });
      let blockedSettled = false;
      void requests[0]!.finally(() => {
        blockedSettled = true;
      });

      // as 29 livres respondem ENQUANTO a wallet 0 segue travada (prazo < lock_timeout de 5 s:
      // se houvesse lock global, nenhuma terminaria antes de o teste soltar a wallet 0)
      const free = await Promise.race([Promise.all(requests.slice(1)), Bun.sleep(3_000).then(() => undefined)]);
      expect(free?.map((r) => r.status)).toEqual(Array(WALLETS - 1).fill(200));
      expect(maxInFlight(free ?? [])).toBeGreaterThan(1);
      // a da wallet travada continua esperando o lock — dentro do banco, não numa fila global
      expect(blockedSettled).toBe(false);
      expect(await countLockWaiters(db.pool, pid)).toBe(1);

      await holder.query("ROLLBACK");
      const results = await Promise.all(requests);
      expect(results.map((r) => r.status)).toEqual(Array(WALLETS).fill(200));
      expect(new Set(results.map(balanceOf))).toEqual(new Set(["90.00"]));
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    for (const walletId of walletIds) {
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
      expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(1);
    }
    await assertGlobalInvariants(db.pool);
  }, 60_000);
});
