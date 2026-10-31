/**
 * §13 Concorrência 5 — processo morto (SIGKILL de verdade, via FaultInjector D20) em volta
 * do COMMIT. Cada cenário sobe o seu próprio cluster porque o ponto de falha é por processo.
 *
 * - HTTP before-commit: nada pode ter sido confirmado; outra instância processa do zero.
 * - HTTP after-commit-before-ack: o efeito está confirmado, o cliente ficou sem resposta;
 *   o reenvio (outra instância) é replay com o resultado ORIGINAL — sem segundo débito.
 * - SQS after-commit-before-ack: o consumer confirma, morre antes do `DeleteMessage`; a
 *   mensagem volta após o visibility timeout e a instância reiniciada não duplica (inbox).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Cluster, eventually } from "../support/cluster";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { inboxRows, ledgerOf, outboxEventTypes, transactionByKey, walletState } from "../support/db-queries";
import { type ApiClient, type HttpResult, asRecord, bet, brl, newPlayerId, openWalletViaApi } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

/** visibility timeout da fila de entrada é 30 s (D9); a redelivery vem depois disso */
const REDELIVERY_DEADLINE_MS = 75_000;

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_crash");
}, 120_000);

afterAll(async () => {
  await db?.drop();
}, 60_000);

async function withCluster(
  tag: string,
  instances: number,
  envFor: (i: number) => Record<string, string> | undefined,
  body: (cluster: Cluster) => Promise<void>,
): Promise<void> {
  const cluster = await Cluster.start({ databaseUrl: db.url, tag, instances, envFor });
  try {
    await body(cluster);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- logs ---\n${cluster.logs()}`, { cause: error });
  } finally {
    await cluster.dispose();
  }
}

/** Requisição que pode ficar sem resposta (o processo morre no meio). */
async function submitExpectingNoResponse(api: ApiClient, body: Parameters<ApiClient["submit"]>[0]): Promise<void> {
  let answered: HttpResult | undefined;
  try {
    answered = await api.submit(body);
  } catch {
    return; // conexão derrubada: o esperado
  }
  throw new Error(`a instância deveria ter morrido sem responder, mas respondeu ${answered.status} ${JSON.stringify(answered.body)}`);
}

describe("§13 concorrência 5 — morte em volta do commit", () => {
  test("HTTP before-commit: SIGKILL com a transação aberta não confirma nada; outra instância processa", async () => {
    await withCluster("crashbc", 2, (i) => (i === 0 ? { FAULT_POINT: "before-commit" } : undefined), async (cluster) => {
      const player = newPlayerId();
      const walletId = await openWalletViaApi(cluster.api(1), player, brl("100.00"));
      const body = bet(walletId, player, "bet-bc", "10.00");

      await submitExpectingNoResponse(cluster.api(0), body);
      await cluster.waitForExit(0, 15_000, "FAULT_POINT=before-commit");

      expect(await transactionByKey(db.pool, "provider-a:bet-bc")).toBeUndefined();
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 1 });
      expect(await ledgerOf(db.pool, walletId)).toHaveLength(1);

      // o lock da wallet morreu com a conexão: a outra instância processa (não é replay)
      const res = await cluster.api(1).submit(body);
      expect(res.status).toBe(200);
      expect(asRecord(res.body)).toMatchObject({ status: "PROCESSED", balance: brl("90.00"), idempotentReplay: false });
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
      await assertGlobalInvariants(db.pool);
    });
  }, 90_000);

  test("HTTP after-commit-before-ack: efeito confirmado sem resposta; reenvio em outra instância = replay, 1 débito", async () => {
    await withCluster("crashack", 2, (i) => (i === 0 ? { FAULT_POINT: "after-commit-before-ack" } : undefined), async (cluster) => {
      const player = newPlayerId();
      const walletId = await openWalletViaApi(cluster.api(1), player, brl("100.00"));
      const body = bet(walletId, player, "bet-ack", "10.00");

      await submitExpectingNoResponse(cluster.api(0), body);
      await cluster.waitForExit(0, 15_000, "FAULT_POINT=after-commit-before-ack");

      const committed = await transactionByKey(db.pool, "provider-a:bet-ack");
      expect(committed).toMatchObject({ status: "PROCESSED", result_balance_amount: "90.00" });
      expect(await outboxEventTypes(db.pool, committed?.id ?? "")).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);

      // saldo muda antes do reenvio: o replay tem de devolver o ORIGINAL (90.00), não o atual
      expect((await cluster.api(1).submit(bet(walletId, player, "bet-after", "5.00"))).status).toBe(200);
      const retry = await cluster.api(1).submit(body);
      expect(retry.status).toBe(200);
      expect(asRecord(retry.body)).toMatchObject({
        transactionId: committed?.id,
        status: "PROCESSED",
        balance: brl("90.00"),
        idempotentReplay: true,
      });
      const debits = (await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT");
      expect(debits.map((d) => d.amount)).toEqual(["10.00", "5.00"]);
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "85.00", version: 3 });
      await assertGlobalInvariants(db.pool);
    });
  }, 90_000);

  test("SQS after-commit-before-ack: consumer morre antes do DeleteMessage; redelivery na instância reiniciada não duplica", async () => {
    await withCluster("crashsqs", 1, () => ({ FAULT_POINT: "after-commit-before-ack" }), async (cluster) => {
      const player = newPlayerId();
      const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
      const messageId = `msg-${randomUUID()}`;
      await cluster.sendWagerMessage({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-a",
          externalTransactionId: "bet-sqs",
          idempotencyKey: "provider-a:bet-sqs",
          playerId: player,
          walletId,
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "BET",
          money: brl("10.00"),
        },
      });

      await cluster.waitForExit(0, 20_000, "o consumer SQS deveria processar a mensagem e morrer em after-commit-before-ack");

      // morreu DEPOIS do commit: efeito e inbox confirmados juntos, mensagem ainda na fila
      const committed = await transactionByKey(db.pool, "provider-a:bet-sqs");
      expect(committed).toMatchObject({ status: "PROCESSED", result_balance_amount: "90.00" });
      expect(await inboxRows(db.pool, messageId)).toHaveLength(1);
      expect(await cluster.queueDepth(cluster.queues.wagerTransactions.url)).toBe(1);

      await cluster.restart(0, { FAULT_POINT: "" });
      await eventually(
        "a mensagem reentregue deveria ser reconhecida (inbox) e apagada da fila",
        () => cluster.queueDepth(cluster.queues.wagerTransactions.url),
        (depth) => depth === 0,
        REDELIVERY_DEADLINE_MS,
        500,
      );

      expect(await cluster.queueDepth(cluster.queues.wagerTransactionsDlq.url)).toBe(0);
      expect(await inboxRows(db.pool, messageId)).toEqual([expect.objectContaining({ processed_at: expect.any(String) })]);
      expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(1);
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
      await assertGlobalInvariants(db.pool);
    });
  }, 150_000);
});
