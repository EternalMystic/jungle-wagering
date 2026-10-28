/**
 * ACEITAÇÃO — API HTTP contra o processo REAL (`bun run src/main.ts`), PostgreSQL e
 * emulador SQS reais, banco isolado por arquivo. Nada é mockado.
 *
 * Todo teste confere o BANCO (não só o status HTTP) e termina com
 * `assertGlobalInvariants`. Os testes de corrida usam `contend`: o teste segura o
 * recurso disputado numa conexão própria e só o solta quando o Postgres mostra as
 * requisições da aplicação bloqueadas AO MESMO TEMPO — prova de sobreposição real.
 *
 * Cobre: cenário obrigatório da §8; a mesma BET 50× em paralelo (§13 concorrência 1);
 * linhas 1, 2, 3, 24 e 26 da matriz pelo caminho da aplicação.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { type AppProcess, startApp } from "../support/app-process";
import { contend, launchTogether, maxInFlight } from "../support/concurrency";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import {
  ApiClient,
  type HttpResult,
  bet,
  brl,
  newPlayerId,
  openWalletViaApi,
  stringField,
} from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";
import { walletRow } from "../support/sql-fixtures";

let db: IsolatedDatabase;
let app: AppProcess;
let api: ApiClient;

beforeAll(async () => {
  db = await createIsolatedDatabase("http");
  app = await startApp({ databaseUrl: db.url, tag: "http" });
  api = new ApiClient(app.baseUrl);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await db?.drop();
}, 60_000);

/** Segura a linha da wallet com FOR UPDATE na conexão do teste (o recurso que as BETs disputam). */
function holdWalletRow(walletId: string) {
  return async (c: PoolClient): Promise<void> => {
    const res = await c.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [walletId]);
    if (res.rowCount !== 1) throw new Error(`wallet ${walletId} não existe no banco`);
  };
}

interface TxRow {
  id: string;
  kind: string;
  status: string;
  amount: string;
  failure_code: string | null;
  result_balance_amount: string | null;
  idempotency_key: string;
}

async function transactionsOf(walletId: string, kind?: string): Promise<TxRow[]> {
  const res = await db.pool.query<TxRow>(
    `SELECT id, kind, status, amount, failure_code, result_balance_amount, idempotency_key
       FROM wager_transactions
      WHERE wallet_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at, id`,
    [walletId, kind ?? null],
  );
  return res.rows;
}

interface LedgerRow {
  transaction_id: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
}

async function ledgerOf(walletId: string): Promise<LedgerRow[]> {
  const res = await db.pool.query<LedgerRow>(
    `SELECT transaction_id, direction, amount, balance_before, balance_after, wallet_version
       FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`,
    [walletId],
  );
  return res.rows;
}

async function outboxCount(transactionId: string, eventType: string): Promise<number> {
  const res = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox_messages
      WHERE event_type = $1 AND payload -> 'data' ->> 'transactionId' = $2`,
    [eventType, transactionId],
  );
  return res.rows[0]?.n ?? -1;
}

function statusesOf(results: readonly HttpResult[]): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

describe("POST /wallets — abertura atômica e unicidade (linhas 24 e 26)", () => {
  test("abre com OPENING + CREDIT na mesma transação SQL e version 1", async () => {
    const playerId = newPlayerId();
    const res = await api.createWallet(playerId, brl("1000.00"));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const walletId = stringField(res.body, "id");

    const wallets = await db.pool.query<{ player_id: string; currency: string; balance_amount: string; version: number }>(
      "SELECT player_id, currency, balance_amount, version FROM wallets WHERE id = $1",
      [walletId],
    );
    expect(wallets.rows).toEqual([{ player_id: playerId, currency: "BRL", balance_amount: "1000.00", version: 1 }]);

    const txs = await transactionsOf(walletId);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ kind: "OPENING", status: "PROCESSED", amount: "1000.00", result_balance_amount: "1000.00" });

    expect(await ledgerOf(walletId)).toEqual([
      {
        transaction_id: txs[0]?.id ?? "",
        direction: "CREDIT",
        amount: "1000.00",
        balance_before: "0.00",
        balance_after: "1000.00",
        wallet_version: 1,
      },
    ]);
    await assertGlobalInvariants(db.pool);
  });

  test("segunda wallet do mesmo player+moeda → 409 WALLET_ALREADY_EXISTS e o banco segue com uma só", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("10.00"));

    const dup = await api.createWallet(playerId, brl("99.00"));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: "WALLET_ALREADY_EXISTS" } });

    const rows = await db.pool.query<{ id: string; balance_amount: string }>(
      "SELECT id, balance_amount FROM wallets WHERE player_id = $1 AND currency = 'BRL'",
      [playerId],
    );
    expect(rows.rows).toEqual([{ id: walletId, balance_amount: "10.00" }]);
    expect(await ledgerOf(walletId)).toHaveLength(1);
    await assertGlobalInvariants(db.pool);
  });

  test("duas criações SIMULTÂNEAS para o mesmo player → uma 201, outra 409; uma wallet, um OPENING, um crédito", async () => {
    const playerId = newPlayerId();

    // o teste ocupa a chave única (player, BRL) com um INSERT não confirmado: as duas
    // criações da aplicação ficam bloqueadas no índice único ao mesmo tempo; ROLLBACK as solta.
    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: async (c) => {
        await c.query(
          "INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (gen_random_uuid(), $1, 'BRL', 0, 1)",
          [playerId],
        );
      },
      run: () => launchTogether(2, () => api.createWallet(playerId, brl("50.00"))),
      expectedWaiters: 2,
    });

    expect(maxWaiters).toBeGreaterThanOrEqual(2);
    expect(statusesOf(results)).toEqual([201, 409]);

    const rows = await db.pool.query<{ id: string; balance_amount: string; version: number }>(
      "SELECT id, balance_amount, version FROM wallets WHERE player_id = $1",
      [playerId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ balance_amount: "50.00", version: 1 });
    const walletId = rows.rows[0]?.id ?? "";
    const created = results.find((r) => r.status === 201);
    expect(created && stringField(created.body, "id")).toBe(walletId);
    expect(await transactionsOf(walletId)).toHaveLength(1);
    expect(await ledgerOf(walletId)).toHaveLength(1);
    await assertGlobalInvariants(db.pool);
  });
});

describe("§8 cenário obrigatório — 100.00 BRL, duas BETs de 80.00 simultâneas (linhas 1, 2, 3)", () => {
  test("uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS, saldo 20.00, um débito; retries não duplicam", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("100.00"));
    const bodies = [bet(walletId, playerId, "s8-bet-a", "80.00"), bet(walletId, playerId, "s8-bet-b", "80.00")] as const;

    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: holdWalletRow(walletId),
      run: () => launchTogether(2, (i) => api.submit(bodies[i % 2] ?? bodies[0])),
      expectedWaiters: 2,
    });

    // houve disputa real: as duas requisições esperaram pelo lock da wallet ao mesmo tempo
    expect(maxWaiters).toBeGreaterThanOrEqual(2);
    expect(statusesOf(results)).toEqual([200, 422]);

    const winner = results.find((r) => r.status === 200);
    const loser = results.find((r) => r.status === 422);
    expect(winner?.body).toMatchObject({ status: "PROCESSED", balance: { amount: "20.00", currency: "BRL" }, idempotentReplay: false });
    expect(loser?.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: false });
    const winnerTxId = stringField(winner?.body, "transactionId");
    const loserTxId = stringField(loser?.body, "transactionId");

    // banco: saldo final, versão, transações e EXATAMENTE um débito
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "20.00", version: 2 });
    const bets = await transactionsOf(walletId, "BET");
    expect(bets).toHaveLength(2);
    expect(bets.find((t) => t.id === winnerTxId)).toMatchObject({
      status: "PROCESSED",
      failure_code: null,
      result_balance_amount: "20.00",
    });
    // o perdedor observou o saldo já debitado (serialização por wallet), e isso fica congelado
    expect(bets.find((t) => t.id === loserTxId)).toMatchObject({
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
      result_balance_amount: "20.00",
    });
    const debits = (await ledgerOf(walletId)).filter((e) => e.direction === "DEBIT");
    expect(debits).toEqual([
      {
        transaction_id: winnerTxId,
        direction: "DEBIT",
        amount: "80.00",
        balance_before: "100.00",
        balance_after: "20.00",
        wallet_version: 2,
      },
    ]);

    // nenhum retry duplica o débito: reenvio das duas, de novo em paralelo
    const retries = await launchTogether(2, (i) => api.submit(bodies[i % 2] ?? bodies[0]));
    expect(statusesOf(retries)).toEqual([200, 422]);
    expect(retries.find((r) => r.status === 200)?.body).toMatchObject({
      transactionId: winnerTxId,
      status: "PROCESSED",
      balance: { amount: "20.00", currency: "BRL" },
      idempotentReplay: true,
    });
    expect(retries.find((r) => r.status === 422)?.body).toMatchObject({
      transactionId: loserTxId,
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      idempotentReplay: true,
    });

    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "20.00", version: 2 });
    expect(await transactionsOf(walletId, "BET")).toHaveLength(2);
    expect((await ledgerOf(walletId)).filter((e) => e.direction === "DEBIT")).toHaveLength(1);
    // eventos do mesmo commit, sem duplicata por causa dos retries
    expect(await outboxCount(winnerTxId, "WagerTransactionProcessed")).toBe(1);
    expect(await outboxCount(winnerTxId, "WalletBalanceChanged")).toBe(1);
    expect(await outboxCount(loserTxId, "WagerTransactionRejected")).toBe(1);
    expect(await outboxCount(loserTxId, "WalletBalanceChanged")).toBe(0);
    await assertGlobalInvariants(db.pool);
  }, 60_000);
});

describe("§13 concorrência 1 — a mesma BET 50× em paralelo via HTTP (linha 3)", () => {
  test("um único débito; 1 resposta original e 49 replays com o saldo ORIGINAL", async () => {
    const PARALLEL = 50;
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("1000.00"));
    const body = bet(walletId, playerId, "same-bet-50x", "10.00");

    const { results, maxWaiters } = await contend({
      pool: db.pool,
      hold: holdWalletRow(walletId),
      run: () => launchTogether(PARALLEL, () => api.submit(body)),
      expectedWaiters: PARALLEL,
    });

    // as 50 requisições estavam DENTRO do banco, esperando o lock da wallet, ao mesmo tempo
    // (exige pool da aplicação ≥ 50: DB_POOL_MAX, ver D16)
    expect(maxWaiters).toBeGreaterThanOrEqual(PARALLEL);
    expect(maxInFlight(results)).toBeGreaterThanOrEqual(PARALLEL);

    expect(results.map((r) => r.status)).toEqual(Array.from({ length: PARALLEL }, () => 200));
    const originals = results.filter((r) => (r.body as { idempotentReplay?: unknown }).idempotentReplay === false);
    const replays = results.filter((r) => (r.body as { idempotentReplay?: unknown }).idempotentReplay === true);
    expect(originals).toHaveLength(1);
    expect(replays).toHaveLength(PARALLEL - 1);

    const txId = stringField(originals[0]?.body, "transactionId");
    for (const r of results) {
      expect(r.body).toMatchObject({
        transactionId: txId,
        status: "PROCESSED",
        balance: { amount: "990.00", currency: "BRL" },
      });
    }

    // banco: UMA transação, UM débito, saldo e versão corretos, eventos sem duplicata
    const bets = await transactionsOf(walletId, "BET");
    expect(bets).toHaveLength(1);
    expect(bets[0]).toMatchObject({
      id: txId,
      status: "PROCESSED",
      amount: "10.00",
      result_balance_amount: "990.00",
      idempotency_key: "provider-a:same-bet-50x",
    });
    expect((await ledgerOf(walletId)).filter((e) => e.direction === "DEBIT")).toEqual([
      {
        transaction_id: txId,
        direction: "DEBIT",
        amount: "10.00",
        balance_before: "1000.00",
        balance_after: "990.00",
        wallet_version: 2,
      },
    ]);
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "990.00", version: 2 });
    expect(await outboxCount(txId, "WagerTransactionProcessed")).toBe(1);
    expect(await outboxCount(txId, "WalletBalanceChanged")).toBe(1);
    await assertGlobalInvariants(db.pool);
  }, 60_000);
});

describe("linha 26 pela API — version só sobe quando o saldo muda", () => {
  test("LOSS não mexe em saldo, versão nem ledger; BET seguinte leva a versão a 2", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("100.00"));

    const loss = await api.submit(bet(walletId, playerId, "loss-1", "10.00", { kind: "LOSS" }));
    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" }, idempotentReplay: false });
    const lossId = stringField(loss.body, "transactionId");

    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "100.00", version: 1 });
    expect((await ledgerOf(walletId)).map((e) => e.transaction_id)).not.toContain(lossId);
    expect(await outboxCount(lossId, "WagerTransactionProcessed")).toBe(1);
    expect(await outboxCount(lossId, "WalletBalanceChanged")).toBe(0);

    const next = await api.submit(bet(walletId, playerId, "bet-after-loss", "10.00"));
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00", currency: "BRL" } });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "90.00", version: 2 });
    expect(await ledgerOf(walletId)).toHaveLength(2);
    await assertGlobalInvariants(db.pool);
  });

  test("BET rejeitada por saldo insuficiente não sobe a versão nem gera lançamento", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("5.00"));

    const res = await api.submit(bet(walletId, playerId, "too-big", "5.01"));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });

    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "5.00", version: 1 });
    expect(await ledgerOf(walletId)).toHaveLength(1);
    const rejected = await transactionsOf(walletId, "BET");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", result_balance_amount: "5.00" });
    await assertGlobalInvariants(db.pool);
  });
});
