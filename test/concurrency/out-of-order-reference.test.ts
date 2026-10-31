/**
 * §13 Concorrência 7 — REFUND/ROLLBACK entregue ANTES da referência (§7.1, D8), em 3
 * processos. A reversão nasce PENDING_REFERENCE (202) e precisa terminar PROCESSED quando
 * a BET chega — por resolução ansiosa no commit da BET ou pelo worker agendado. Se nenhum
 * dos dois resolver, o `eventually` falha com o último estado lido.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Cluster, eventually } from "../support/cluster";
import { launchTogether } from "../support/concurrency";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { ledgerOf, outboxEventTypes, transactionByKey, transactionsOf, walletState } from "../support/db-queries";
import { asRecord, bet, brl, newPlayerId, openWalletViaApi } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

/** D8: primeira nova tentativa em +5 s; com resolução ansiosa deveria ser imediato */
const RESOLUTION_DEADLINE_MS = 30_000;

let db: IsolatedDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_ooo");
  cluster = await Cluster.start({ databaseUrl: db.url, tag: "concooo", instances: 3 });
}, 120_000);

afterAll(async () => {
  await cluster?.dispose();
  await db?.drop();
}, 60_000);

const terminal = (status: string | undefined) => status === "PROCESSED" || status === "REJECTED";

describe("§13 concorrência 7 — reversão antes da referência", () => {
  test("REFUND antes da BET: 202 → BET em outra instância → REFUND PROCESSED, saldo volta ao inicial", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const refund = bet(walletId, player, "refund-1", "30.00", { kind: "REFUND", referenceExternalTransactionId: "bet-1" });

    const early = await cluster.api(0).submit(refund);
    expect(early.status).toBe(202);
    expect(asRecord(early.body)).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 1 });

    const placed = await cluster.api(1).submit(bet(walletId, player, "bet-1", "30.00"));
    expect(placed.status).toBe(200);

    const resolved = await eventually(
      "REFUND pendente resolvido depois que a BET chegou",
      () => transactionByKey(db.pool, "provider-a:refund-1"),
      (tx) => terminal(tx?.status),
      RESOLUTION_DEADLINE_MS,
    );
    const betTx = await transactionByKey(db.pool, "provider-a:bet-1");
    expect(resolved).toMatchObject({ status: "PROCESSED", reference_transaction_id: betTx?.id, result_balance_amount: "100.00" });
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 3 });
    expect((await ledgerOf(db.pool, walletId)).map((l) => [l.direction, l.amount])).toEqual([
      ["CREDIT", "100.00"],
      ["DEBIT", "30.00"],
      ["CREDIT", "30.00"],
    ]);
    expect(await outboxEventTypes(db.pool, resolved?.id ?? "")).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    // reenvio do REFUND em uma terceira instância: replay do resultado terminal
    const replay = await cluster.api(2).submit(refund);
    expect(replay.status).toBe(200);
    expect(asRecord(replay.body)).toMatchObject({ transactionId: resolved?.id, status: "PROCESSED", idempotentReplay: true });
    await assertGlobalInvariants(db.pool);
  }, 90_000);

  test("10 rodadas com ROLLBACK e BET disparados JUNTOS em instâncias diferentes → todas revertidas exatamente uma vez", async () => {
    const ROUNDS = 10;
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const sends = Array.from({ length: ROUNDS }, (_, r) => [
      bet(walletId, player, `bet-r${r}`, "10.00", { roundId: `round-${r}` }),
      bet(walletId, player, `rb-r${r}`, "10.00", { roundId: `round-${r}`, kind: "ROLLBACK", referenceExternalTransactionId: `bet-r${r}` }),
    ]).flat();

    const results = await launchTogether(sends.length, (i) => cluster.api(i).submit(sends[i]!));
    for (const [i, r] of results.entries()) {
      // BET: 200; ROLLBACK: 200 (BET chegou antes) ou 202 (chegou antes da BET)
      expect(i % 2 === 0 ? [200] : [200, 202]).toContain(r.status);
    }

    await eventually(
      "todos os ROLLBACKs resolvidos",
      async () => (await transactionsOf(db.pool, walletId)).filter((t) => t.kind === "ROLLBACK").map((t) => t.status),
      (statuses) => statuses.length === ROUNDS && statuses.every((s) => s === "PROCESSED"),
      RESOLUTION_DEADLINE_MS,
    );
    const ledger = await ledgerOf(db.pool, walletId);
    expect(ledger.filter((l) => l.direction === "DEBIT")).toHaveLength(ROUNDS);
    expect(ledger.filter((l) => l.direction === "CREDIT")).toHaveLength(1 + ROUNDS);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 1 + 2 * ROUNDS });
    await assertGlobalInvariants(db.pool);
  }, 90_000);

  test("REFUND e ROLLBACK da mesma BET, ambos antes dela e em paralelo → uma única reversão (D7)", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const reversals = [
      bet(walletId, player, "refund-x", "40.00", { kind: "REFUND", referenceExternalTransactionId: "bet-x" }),
      bet(walletId, player, "rollback-x", "40.00", { kind: "ROLLBACK", referenceExternalTransactionId: "bet-x" }),
    ];
    const early = await launchTogether(2, (i) => cluster.api(i).submit(reversals[i]!));
    expect(early.map((r) => r.status)).toEqual([202, 202]);

    expect((await cluster.api(2).submit(bet(walletId, player, "bet-x", "40.00"))).status).toBe(200);

    const settled = await eventually(
      "as duas reversões pendentes chegam a estado terminal",
      async () => (await transactionsOf(db.pool, walletId)).filter((t) => t.kind === "REFUND" || t.kind === "ROLLBACK"),
      (txs) => txs.length === 2 && txs.every((t) => terminal(t.status)),
      RESOLUTION_DEADLINE_MS,
    );
    expect(settled.map((t) => t.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(settled.find((t) => t.status === "REJECTED")?.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 3 });
    await assertGlobalInvariants(db.pool);
  }, 90_000);
});
