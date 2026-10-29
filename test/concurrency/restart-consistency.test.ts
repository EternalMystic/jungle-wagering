/**
 * §13 Concorrência 8 — reinício do serviço no meio da carga, com prova da consistência final.
 *
 * 3 processos; 4 wallets; 30 BETs por wallet. As wallets 2 e 3 ficam travadas pelo teste,
 * então as suas BETs estão DENTRO do banco esperando o lock quando TODAS as instâncias levam
 * SIGKILL; as das wallets 0 e 1 já foram confirmadas e respondidas. Instâncias novas (outros
 * pids, outras portas) recebem o reenvio de TODAS as operações com as mesmas keys:
 *   - as confirmadas → replay com o resultado original (idempotência sobrevive ao restart:
 *     não há estado em memória);
 *   - as que morreram com a transação aberta → processadas agora, uma única vez.
 * Saldo final = esperado = ledger; invariantes vazias.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Cluster, eventually } from "../support/cluster";
import { StartBarrier, countLockWaiters } from "../support/concurrency";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { ledgerOf, transactionsOf, walletState } from "../support/db-queries";
import {
  type HttpResult,
  type WagerRequestBody,
  asRecord,
  bet,
  brl,
  newPlayerId,
  openWalletViaApi,
} from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

const WALLETS = 4;
const BETS_PER_WALLET = 30;

let db: IsolatedDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_restart");
  cluster = await Cluster.start({ databaseUrl: db.url, tag: "concrestart", instances: 3 });
}, 120_000);

afterAll(async () => {
  await cluster?.dispose();
  await db?.drop();
}, 60_000);

type Outcome = { ok: true; res: HttpResult } | { ok: false };

describe("§13 concorrência 8 — reinício de todas as instâncias no meio da carga", () => {
  test("SIGKILL em todas com transações abertas + restart + reenvio → um efeito por operação, saldo = ledger", async () => {
    const players = Array.from({ length: WALLETS }, () => newPlayerId());
    const walletIds = await Promise.all(players.map((p, i) => openWalletViaApi(cluster.api(i), p, brl("1000.00"))));
    const ops: WagerRequestBody[] = Array.from({ length: WALLETS * BETS_PER_WALLET }, (_, i) =>
      bet(walletIds[i % WALLETS]!, players[i % WALLETS]!, `rs-bet-${i}`, "5.00"),
    );
    const frozen = walletIds.slice(2);
    const frozenOps = ops.filter((o) => frozen.includes(o.walletId)).length;
    const oldPids = cluster.instances.map((i) => i.pid);

    const holder = await db.pool.connect();
    let first: Outcome[];
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? -1;
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM wallets WHERE id = ANY($1::uuid[]) FOR UPDATE", [frozen]);

      const barrier = new StartBarrier(ops.length);
      const inFlight = ops.map(async (op, i): Promise<Outcome> => {
        await barrier.arrive();
        try {
          return { ok: true, res: await cluster.api(i).submit(op) };
        } catch {
          return { ok: false };
        }
      });
      const free = inFlight.filter((_, i) => !frozen.includes(ops[i]!.walletId));
      // carga "no meio": as livres confirmadas e respondidas, as travadas esperando NO banco
      const freeDone = await Promise.all(free);
      expect(freeDone.every((o) => o.ok && o.res.status === 200)).toBe(true);
      await eventually("BETs das wallets travadas esperando o lock", () => countLockWaiters(db.pool, pid), (n) => n >= 20, 3_000, 10);

      await cluster.killAll();
      await holder.query("ROLLBACK");
      first = await Promise.all(inFlight);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    const lost = first.filter((o) => !o.ok || o.res.status !== 200).length;
    expect(lost).toBe(frozenOps); // todas as das wallets travadas ficaram sem resposta

    // as conexões mortas não confirmaram nada nas wallets travadas
    await eventually("backends das instâncias mortas encerrados", () => countLockWaiters(db.pool, -1), (n) => n === 0, 10_000, 50);
    for (const w of frozen) {
      expect(await walletState(db.pool, w)).toEqual({ balance: "1000.00", version: 1 });
    }

    await cluster.restartAll();
    expect(cluster.instances.some((i) => oldPids.includes(i.pid))).toBe(false);

    // reenvio de TODAS as operações, em paralelo, pelas instâncias novas
    const barrier = new StartBarrier(ops.length);
    const second = await Promise.all(
      ops.map(async (op, i) => {
        await barrier.arrive();
        return cluster.api(i + 1).submit(op);
      }),
    );
    second.forEach((res, i) => {
      expect(res.status).toBe(200);
      const before = first[i]!;
      if (before.ok && before.res.status === 200) {
        // confirmada antes do crash → replay ORIGINAL depois do restart
        expect(asRecord(res.body)).toMatchObject({
          transactionId: asRecord(before.res.body).transactionId,
          balance: asRecord(before.res.body).balance,
          idempotentReplay: true,
        });
      } else {
        expect(asRecord(res.body)).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
      }
    });

    const expected = `${1000 - BETS_PER_WALLET * 5}.00`;
    for (const walletId of walletIds) {
      expect(await walletState(db.pool, walletId)).toEqual({ balance: expected, version: 1 + BETS_PER_WALLET });
      expect(await transactionsOf(db.pool, walletId)).toHaveLength(1 + BETS_PER_WALLET);
      expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(BETS_PER_WALLET);
    }
    await assertGlobalInvariants(db.pool);
  }, 120_000);
});
