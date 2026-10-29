/**
 * INTEGRAÇÃO — mapeamento D5 e regras D7/D8 pela API, contra o processo REAL
 * (`bun run src/main.ts`), PostgreSQL e emulador SQS reais, banco isolado por arquivo.
 * Cada caso confere o BANCO, não só o status, e termina com `assertGlobalInvariants`.
 *
 * Linhas da matriz: 5 (payload divergente → 409), 20 (reversão sem saldo → código
 * distinto), 23 (conflito de moeda), 25 (OPENING via API → 400) e o 202 de D8.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppProcess, startApp } from "../support/app-process";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { ApiClient, bet, brl, newPlayerId, openWalletViaApi, stringField } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";
import { walletRow } from "../support/sql-fixtures";

let db: IsolatedDatabase;
let app: AppProcess;
let api: ApiClient;

beforeAll(async () => {
  db = await createIsolatedDatabase("api");
  app = await startApp({ databaseUrl: db.url, tag: "api" });
  api = new ApiClient(app.baseUrl);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await db?.drop();
}, 60_000);

async function countTransactions(walletId: string): Promise<number> {
  const res = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1", [walletId]);
  return res.rows[0]?.n ?? -1;
}

async function txRow(id: string) {
  const res = await db.pool.query<{ status: string; failure_code: string | null; result_balance_amount: string | null; reference_transaction_id: string | null }>(
    "SELECT status, failure_code, result_balance_amount, reference_transaction_id FROM wager_transactions WHERE id = $1",
    [id],
  );
  return res.rows[0];
}

describe("400 — payload inválido nunca toca o banco", () => {
  test("sem Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("10.00"));
    const res = await api.request("POST", "/wagering/transactions", { body: bet(walletId, playerId, "no-key", "1.00") });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false } });
    expect(await countTransactions(walletId)).toBe(1); // só o OPENING
    await assertGlobalInvariants(db.pool);
  });

  test("kind OPENING via API → 400 INVALID_PAYLOAD (linha 25)", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("10.00"));
    const res = await api.submit(bet(walletId, playerId, "fake-opening", "1000.00", { kind: "OPENING" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "10.00", version: 1 });
    expect(await countTransactions(walletId)).toBe(1);
    await assertGlobalInvariants(db.pool);
  });

  test.each([
    ["número em vez de string", { amount: 1, currency: "BRL" }],
    ["notação científica", { amount: "1e3", currency: "BRL" }],
    ["três casas", { amount: "1.005", currency: "BRL" }],
    ["negativo", { amount: "-1.00", currency: "BRL" }],
    ["moeda inválida", { amount: "1.00", currency: "brl" }],
  ])("money com %s → 400 INVALID_PAYLOAD", async (_label, money) => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("10.00"));
    const body = { ...bet(walletId, playerId, `bad-money-${_label}`, "1.00"), money };
    const res = await api.request("POST", "/wagering/transactions", {
      body,
      headers: { "idempotency-key": `bad-${walletId}` },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
    expect(await countTransactions(walletId)).toBe(1);
  });

  test("REFUND sem referenceExternalTransactionId → 400", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("10.00"));
    const res = await api.submit(bet(walletId, playerId, "refund-no-ref", "1.00", { kind: "REFUND" }));
    expect(res.status).toBe(400);
    expect(await countTransactions(walletId)).toBe(1);
  });

  test("JSON mal formado → 400 INVALID_PAYLOAD no formato de erro padrão", async () => {
    const res = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
  });

  test("POST /wallets com saldo inválido → 400 e nenhuma wallet", async () => {
    const playerId = newPlayerId();
    const res = await api.createWallet(playerId, { amount: "10", currency: "BRL" });
    expect(res.status).toBe(400);
    const rows = await db.pool.query("SELECT 1 FROM wallets WHERE player_id = $1", [playerId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("409 — mesma key com payload diferente é conflito, não replay (linha 5)", () => {
  test("valor divergente com a mesma key → 409; nada novo no banco; o original continua replayável", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("100.00"));
    const original = await api.submit(bet(walletId, playerId, "div-1", "10.00"));
    expect(original.status).toBe(200);

    const divergent = await api.submit(bet(walletId, playerId, "div-1", "11.00"));
    expect(divergent.status).toBe(409);
    expect(divergent.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT", retryable: false } });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "90.00", version: 2 });
    expect(await countTransactions(walletId)).toBe(2);

    const replay = await api.submit(bet(walletId, playerId, "div-1", "10.00"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: stringField(original.body, "transactionId"), idempotentReplay: true });
    await assertGlobalInvariants(db.pool);
  });
});

describe("422 — rejeições de negócio (mesmo corpo do 200)", () => {
  test("wallet inexistente → 422 WALLET_NOT_FOUND, sem persistir (D6)", async () => {
    const walletId = crypto.randomUUID();
    const res = await api.submit(bet(walletId, newPlayerId(), "ghost", "1.00"));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: null,
      status: "REJECTED",
      balance: null,
      failureCode: "WALLET_NOT_FOUND",
      idempotentReplay: false,
    });
    const rows = await db.pool.query("SELECT 1 FROM wager_transactions WHERE idempotency_key = 'provider-a:ghost'");
    expect(rows.rowCount).toBe(0);
  });

  test("moeda diferente da wallet → 422 CURRENCY_MISMATCH persistida com o saldo da wallet (linha 23)", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("50.00"));
    const res = await api.submit(bet(walletId, playerId, "usd-bet", "1.00", { money: { amount: "1.00", currency: "USD" } }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH", balance: { amount: "50.00", currency: "BRL" } });
    expect(await txRow(stringField(res.body, "transactionId"))).toMatchObject({ status: "REJECTED", failure_code: "CURRENCY_MISMATCH" });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "50.00", version: 1 });

    // replay da rejeição: mesmo status e mesmo corpo, inclusive a moeda do saldo observado
    const replay = await api.submit(bet(walletId, playerId, "usd-bet", "1.00", { money: { amount: "1.00", currency: "USD" } }));
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: "CURRENCY_MISMATCH", balance: { amount: "50.00", currency: "BRL" }, idempotentReplay: true });
    await assertGlobalInvariants(db.pool);
  });

  test("ROLLBACK de WIN já gasto → 422 REVERSAL_INSUFFICIENT_FUNDS, auditável (linha 20)", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("0.00"));
    expect((await api.submit(bet(walletId, playerId, "win-a", "50.00", { kind: "WIN" }))).status).toBe(200);
    expect((await api.submit(bet(walletId, playerId, "bet-a", "40.00"))).status).toBe(200);

    const rb = await api.submit(bet(walletId, playerId, "rb-win-a", "50.00", { kind: "ROLLBACK", referenceExternalTransactionId: "win-a" }));
    expect(rb.status).toBe(422);
    expect(rb.body).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    expect(await txRow(stringField(rb.body, "transactionId"))).toMatchObject({
      status: "REJECTED",
      failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
      result_balance_amount: "10.00",
    });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "10.00", version: 3 });
    await assertGlobalInvariants(db.pool);
  });
});

describe("202 — referência fora de ordem (D8, sem o worker)", () => {
  test("REFUND antes da BET → 202 PENDING_REFERENCE; replay → 202; saldo intacto; evento PendingReference", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("100.00"));
    const refund = bet(walletId, playerId, "early-refund", "30.00", { kind: "REFUND", referenceExternalTransactionId: "late-bet" });

    const res = await api.submit(refund);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null, idempotentReplay: false });
    const txId = stringField(res.body, "transactionId");
    const row = await db.pool.query<{ status: string; next_reference_attempt_at: Date | null }>(
      "SELECT status, next_reference_attempt_at FROM wager_transactions WHERE id = $1",
      [txId],
    );
    expect(row.rows[0]?.status).toBe("PENDING_REFERENCE");
    expect(row.rows[0]?.next_reference_attempt_at).not.toBeNull();
    const events = await db.pool.query(
      "SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference' AND payload -> 'data' ->> 'transactionId' = $1",
      [txId],
    );
    expect(events.rowCount).toBe(1);

    const replay = await api.submit(refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ transactionId: txId, status: "PENDING_REFERENCE", idempotentReplay: true });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "100.00", version: 1 });
    await assertGlobalInvariants(db.pool);
  });

  test("REFUND depois da BET → 200 ligado à BET; ROLLBACK da mesma BET → 422 REFERENCE_ALREADY_REVERSED (D7)", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("100.00"));
    const placed = await api.submit(bet(walletId, playerId, "bet-r", "30.00"));
    const refund = await api.submit(bet(walletId, playerId, "refund-r", "30.00", { kind: "REFUND", referenceExternalTransactionId: "bet-r" }));
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(await txRow(stringField(refund.body, "transactionId"))).toMatchObject({
      reference_transaction_id: stringField(placed.body, "transactionId"),
    });

    const rollback = await api.submit(bet(walletId, playerId, "rb-r", "30.00", { kind: "ROLLBACK", referenceExternalTransactionId: "bet-r" }));
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: "REFERENCE_ALREADY_REVERSED" });
    expect(await walletRow(db.pool, walletId)).toEqual({ balance_amount: "100.00", version: 3 });
    await assertGlobalInvariants(db.pool);
  });
});

describe("GET — consultas da §9", () => {
  test("wallet, transação por id e por (provider, external); inexistentes → 404 NOT_FOUND", async () => {
    const playerId = newPlayerId();
    const walletId = await openWalletViaApi(api, playerId, brl("20.00"));
    const placed = await api.submit(bet(walletId, playerId, "get-bet", "5.00"));
    const txId = stringField(placed.body, "transactionId");

    const wallet = await api.getWallet(walletId);
    expect(wallet.status).toBe(200);
    expect(wallet.body).toEqual({ id: walletId, playerId, balance: { amount: "15.00", currency: "BRL" }, version: 2 });

    const byId = await api.request("GET", `/wagering/transactions/${txId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ transactionId: txId, kind: "BET", status: "PROCESSED", balance: { amount: "15.00" } });

    const byExt = await api.request("GET", "/providers/provider-a/wagering/transactions/get-bet");
    expect(byExt.status).toBe(200);
    expect(byExt.body).toMatchObject({ transactionId: txId });

    for (const path of [`/wallets/${crypto.randomUUID()}`, "/wallets/not-a-uuid", `/wagering/transactions/${crypto.randomUUID()}`, "/providers/provider-a/wagering/transactions/nope"]) {
      const res = await api.request("GET", path);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    await assertGlobalInvariants(db.pool);
  });
});
