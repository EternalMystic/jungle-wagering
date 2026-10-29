/**
 * §13 Concorrência 4 — ≥ 3 processos simultâneos (§8: "três ou mais instâncias").
 * Carga mista (BET / WIN / LOSS) em 6 wallets; CADA operação é enviada 3 vezes, uma por
 * instância, ao mesmo tempo (redelivery/retry do provedor caindo em processos diferentes).
 * A disputa é provada no Postgres: o teste segura as 6 wallets e só solta quando > 50
 * backends — mais do que o pool de duas instâncias somadas — estão bloqueados juntos.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { Cluster, INSTANCE_POOL_MAX } from "../support/cluster";
import { contend, launchTogether } from "../support/concurrency";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { ledgerOf, transactionsOf, walletState } from "../support/db-queries";
import {
  type WagerRequestBody,
  asRecord,
  bet,
  brl,
  newPlayerId,
  openWalletViaApi,
} from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

const INSTANCES = 3;
const WALLETS = 6;
const BETS = 8; // 10.00 cada
const WINS = 4; // 7.00 cada, sem referência (D7)
const LOSSES = 2; // 1.00, não move saldo

let db: IsolatedDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_multi");
  cluster = await Cluster.start({ databaseUrl: db.url, tag: "concmulti", instances: INSTANCES });
}, 120_000);

afterAll(async () => {
  await cluster?.dispose();
  await db?.drop();
}, 60_000);

describe("§13 concorrência 4 — 3 processos sobre as mesmas wallets", () => {
  test("operações duplicadas entre instâncias: um efeito por operação, saldo = ledger = esperado", async () => {
    expect(cluster.size).toBeGreaterThanOrEqual(3);
    expect(new Set(cluster.instances.map((i) => i.pid)).size).toBe(INSTANCES);

    const players = Array.from({ length: WALLETS }, () => newPlayerId());
    const walletIds = await Promise.all(players.map((p, i) => openWalletViaApi(cluster.api(i), p, brl("1000.00"))));

    const ops: WagerRequestBody[] = [];
    walletIds.forEach((walletId, w) => {
      const player = players[w]!;
      for (let k = 0; k < BETS; k++) ops.push(bet(walletId, player, `w${w}-bet-${k}`, "10.00"));
      for (let k = 0; k < WINS; k++) ops.push(bet(walletId, player, `w${w}-win-${k}`, "7.00", { kind: "WIN" }));
      for (let k = 0; k < LOSSES; k++) ops.push(bet(walletId, player, `w${w}-loss-${k}`, "1.00", { kind: "LOSS" }));
    });
    // operação j vai às instâncias 0, 1 e 2 (cópia c → instância (j + c) mod 3)
    const sends = ops.flatMap((op, j) => Array.from({ length: INSTANCES }, (_, c) => ({ op, j, instance: (j + c) % INSTANCES })));

    const expectedWaiters = 2 * INSTANCE_POOL_MAX + 1;
    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: async (c: PoolClient) => {
        await c.query("SELECT id FROM wallets WHERE id = ANY($1::uuid[]) FOR UPDATE", [walletIds]);
      },
      expectedWaiters,
      run: () => launchTogether(sends.length, (i) => cluster.instance(sends[i]!.instance).api.submit(sends[i]!.op)),
    });
    // mais backends esperando juntos do que caberia em 2 pools: as 3 instâncias estavam no banco
    expect(maxWaiters).toBeGreaterThanOrEqual(expectedWaiters);

    const byOp = new Map<number, Record<string, unknown>[]>();
    results.forEach((r, i) => {
      expect(r.status).toBe(200);
      const j = sends[i]!.j;
      byOp.set(j, [...(byOp.get(j) ?? []), asRecord(r.body)]);
    });
    for (const [j, bodies] of byOp) {
      expect(bodies).toHaveLength(INSTANCES);
      expect(bodies.filter((b) => b.idempotentReplay === false)).toHaveLength(1);
      expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
      expect(new Set(bodies.map((b) => JSON.stringify(b.balance))).size).toBe(1);
      expect(bodies[0]).toMatchObject({ status: "PROCESSED" });
      expect(ops[j]).toBeDefined();
    }

    const expected = `${1000 - BETS * 10 + WINS * 7}.00`;
    for (const walletId of walletIds) {
      expect(await walletState(db.pool, walletId)).toEqual({ balance: expected, version: 1 + BETS + WINS });
      const txs = await transactionsOf(db.pool, walletId);
      expect(txs).toHaveLength(1 + BETS + WINS + LOSSES);
      expect(txs.every((t) => t.status === "PROCESSED")).toBe(true);
      const ledger = await ledgerOf(db.pool, walletId);
      expect(ledger.filter((l) => l.direction === "DEBIT")).toHaveLength(BETS);
      expect(ledger.filter((l) => l.direction === "CREDIT")).toHaveLength(1 + WINS);
      expect(ledger.map((l) => l.wallet_version)).toEqual(Array.from({ length: 1 + BETS + WINS }, (_, v) => v + 1));
    }
    await assertGlobalInvariants(db.pool);
  }, 120_000);
});
