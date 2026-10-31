/**
 * ACEITAÇÃO — as garantias da §6 vivem NO SCHEMA (§5.9), não só no código.
 *
 * Cada teste ataca o banco migrado pelo comando de produção (`scripts/migrate.ts up`,
 * via template) com SQL cru, sem a aplicação, e exige o SQLSTATE esperado — no próprio
 * statement ou no COMMIT (constraint triggers diferidos). Depois confere que o estado
 * do banco não mudou e roda `assertGlobalInvariants`.
 *
 * Matriz (docs/INVARIANTES.md): linhas 1, 2, 3, 7, 8, 19, 23, 24, 26.
 * Recusas de CHECK exigem também ONDE (statement × COMMIT) e QUAL constraint, para que
 * nenhum ataque passe por acidente com outro 23514 (D17).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { assertGlobalInvariants } from "../support/invariants";
import {
  type PgFailure,
  type SqlWallet,
  asPgFailure,
  expectRejectedBySchema,
  insertLedger,
  insertOutbox,
  insertTx,
  openWalletBySql,
  walletRow,
} from "../support/sql-fixtures";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const RESTRICT_VIOLATION = "23001";
const FOREIGN_KEY_VIOLATION = "23503";

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await createIsolatedDatabase("schema");
}, 120_000);

afterAll(async () => {
  await db?.drop();
}, 30_000);

async function ledgerCount(walletId: string): Promise<number> {
  const res = await db.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1",
    [walletId],
  );
  return res.rows[0]?.n ?? -1;
}

/** Estado completo de uma wallet para provar que um ataque recusado não deixou rastro. */
async function snapshot(w: SqlWallet) {
  const wallet = await walletRow(db.pool, w.walletId);
  const tx = await db.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1",
    [w.walletId],
  );
  return { wallet, ledger: await ledgerCount(w.walletId), transactions: tx.rows[0]?.n ?? -1 };
}

describe("linha 1 — saldo nunca negativo (CHECK no schema)", () => {
  test("UPDATE que deixa a wallet negativa é recusado (23514)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);

    // tem de ser o CHECK da coluna (imediato), não o trigger diferido que também recusaria
    await expectRejectedBySchema(
      db.pool,
      { code: CHECK_VIOLATION, at: "statement", check: { table: "wallets", definition: /balance_amount >= / } },
      (c) => c.query("UPDATE wallets SET balance_amount = -0.01, version = version + 1 WHERE id = $1", [w.walletId]),
    );

    expect(await snapshot(w)).toEqual(before);
    expect(before.wallet).toEqual({ balance_amount: "100.00", version: 1 });
    await assertGlobalInvariants(db.pool);
  });

  test("débito maior que o saldo, com lançamento 'coerente', é recusado (balance_after < 0)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);

    const check = { table: "wallet_ledger_entries", definition: /balance_after >= / };
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "statement", check }, async (c) => {
      const tx = await insertTx(c, w, { kind: "BET", amount: "150.00", status: "PENDING" });
      await insertLedger(c, w, { txId: tx.id, direction: "DEBIT", amount: "150.00", before: "100.00", after: "-50.00", version: 2 });
      await c.query("UPDATE wallets SET balance_amount = -50.00, version = 2 WHERE id = $1", [w.walletId]);
    });

    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 2 — sem lost update: read → calculate → update sem lock é recusado pelo banco", () => {
  test("duas conexões leem 100.00/v1 e debitam 80; a segunda é barrada por uq_ledger_wallet_version", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const a = await db.pool.connect();
    const b = await db.pool.connect();
    let bFailure: PgFailure | undefined;
    try {
      // conexões DISTINTAS; ambas leem antes de qualquer escrita (SELECT simples, sem FOR UPDATE).
      // A intercalação é determinística: nenhuma espera, nenhum sleep.
      await a.query("BEGIN");
      await b.query("BEGIN");
      const readA = await a.query<{ balance_amount: string; version: number }>(
        "SELECT balance_amount, version FROM wallets WHERE id = $1",
        [w.walletId],
      );
      const readB = await b.query<{ balance_amount: string; version: number }>(
        "SELECT balance_amount, version FROM wallets WHERE id = $1",
        [w.walletId],
      );
      expect(readA.rows[0]).toEqual({ balance_amount: "100.00", version: 1 });
      expect(readB.rows[0]).toEqual({ balance_amount: "100.00", version: 1 });

      // A aplica 100 − 80 = 20 a partir do que leu e confirma
      const txA = await insertTx(a, w, { kind: "BET", amount: "80.00", status: "PROCESSED", resultBalance: "20.00" });
      await a.query("UPDATE wallets SET balance_amount = 20.00, version = 2 WHERE id = $1", [w.walletId]);
      await insertLedger(a, w, { txId: txA.id, direction: "DEBIT", amount: "80.00", before: "100.00", after: "20.00", version: 2 });
      await insertOutbox(a, w.walletId, "WagerTransactionProcessed", txA.id);
      await insertOutbox(a, w.walletId, "WalletBalanceChanged", txA.id);
      await a.query("COMMIT");

      // B aplica o MESMO cálculo sobre a leitura velha: o lost update clássico
      try {
        const txB = await insertTx(b, w, { kind: "BET", amount: "80.00", status: "PROCESSED", resultBalance: "20.00" });
        await b.query("UPDATE wallets SET balance_amount = 20.00, version = 2 WHERE id = $1", [w.walletId]);
        await insertLedger(b, w, { txId: txB.id, direction: "DEBIT", amount: "80.00", before: "100.00", after: "20.00", version: 2 });
        await insertOutbox(b, w.walletId, "WagerTransactionProcessed", txB.id);
        await insertOutbox(b, w.walletId, "WalletBalanceChanged", txB.id);
        await b.query("COMMIT");
      } catch (error) {
        bFailure = asPgFailure(error);
        await b.query("ROLLBACK");
      }
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }

    expect(bFailure?.code).toBe(UNIQUE_VIOLATION);
    expect(bFailure?.constraint).toBe("uq_ledger_wallet_version");

    expect(await walletRow(db.pool, w.walletId)).toEqual({ balance_amount: "20.00", version: 2 });
    const debits = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [w.walletId],
    );
    expect(debits.rows[0]?.n).toBe(1);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 3 — débito/crédito nunca duplicado (UNIQUEs)", () => {
  test("idempotency_key repetida é recusada (uq_tx_idempotency_key)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: UNIQUE_VIOLATION, constraint: "uq_tx_idempotency_key" }, async (c) => {
      await insertTx(c, w, { kind: "BET", amount: "10.00", status: "PENDING", externalId: "dup-a", idempotencyKey: "provider-a:same" });
      await insertTx(c, w, { kind: "BET", amount: "10.00", status: "PENDING", externalId: "dup-b", idempotencyKey: "provider-a:same" });
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("mesmo (provider, externalTransactionId) com outra key é recusado (uq_tx_provider_external)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: UNIQUE_VIOLATION, constraint: "uq_tx_provider_external" }, async (c) => {
      await insertTx(c, w, { kind: "BET", amount: "10.00", status: "PENDING", externalId: "ext-1", idempotencyKey: "k-1" });
      await insertTx(c, w, { kind: "BET", amount: "10.00", status: "PENDING", externalId: "ext-1", idempotencyKey: "k-2" });
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("segundo lançamento da MESMA transação na mesma wallet é recusado (uq_ledger_one_entry_per_tx_wallet)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(
      db.pool,
      { code: UNIQUE_VIOLATION, constraint: "uq_ledger_one_entry_per_tx_wallet" },
      async (c) => {
        const tx = await insertTx(c, w, { kind: "BET", amount: "10.00", status: "PENDING" });
        await insertLedger(c, w, { txId: tx.id, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", version: 2 });
        await insertLedger(c, w, { txId: tx.id, direction: "DEBIT", amount: "10.00", before: "90.00", after: "80.00", version: 3 });
        await c.query("UPDATE wallets SET balance_amount = 80.00, version = 3 WHERE id = $1", [w.walletId]);
      },
    );
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 7 — toda mudança de saldo ⇔ lançamento (constraint triggers diferidos)", () => {
  // `at: "commit"` em toda a linha 7: prova que a recusa veio do constraint trigger
  // DIFERIDO, e não de um CHECK imediato disparado por alguma linha forjada inválida.
  test("mudar o saldo sem lançamento é recusado no COMMIT", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, (c) =>
      c.query("UPDATE wallets SET balance_amount = 90.00, version = version + 1 WHERE id = $1", [w.walletId]),
    );
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("lançamento órfão (a wallet não acompanha) é recusado no COMMIT", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, async (c) => {
      const tx = await insertTx(c, w, { kind: "WIN", amount: "10.00", status: "PENDING" });
      await insertLedger(c, w, { txId: tx.id, direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00", version: 2 });
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("lançamento que não explica a mudança (balance_before ≠ saldo anterior) é recusado", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, async (c) => {
      const tx = await insertTx(c, w, { kind: "WIN", amount: "10.00", status: "PENDING" });
      await insertLedger(c, w, { txId: tx.id, direction: "CREDIT", amount: "10.00", before: "50.00", after: "60.00", version: 2 });
      await c.query("UPDATE wallets SET balance_amount = 60.00, version = 2 WHERE id = $1", [w.walletId]);
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("wallet aberta com saldo sem crédito OPENING é recusada no COMMIT", async () => {
    const playerId = randomUUID();
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, (c) =>
      c.query("INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 50.00, 1)", [
        randomUUID(),
        playerId,
      ]),
    );
    const res = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM wallets WHERE player_id = $1", [playerId]);
    expect(res.rows[0]?.n).toBe(0);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 8 — ledger append-only (triggers)", () => {
  async function firstEntry(w: SqlWallet): Promise<{ id: string; amount: string; balance_after: string }> {
    const res = await db.pool.query<{ id: string; amount: string; balance_after: string }>(
      "SELECT id, amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1",
      [w.walletId],
    );
    const row = res.rows[0];
    if (!row) throw new Error("wallet sem lançamento de abertura");
    return row;
  }

  test("UPDATE em lançamento é recusado (23001) e o lançamento fica intacto", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const entry = await firstEntry(w);
    await expectRejectedBySchema(db.pool, { code: RESTRICT_VIOLATION }, (c) =>
      c.query("UPDATE wallet_ledger_entries SET amount = 1.00, balance_after = 1.00 WHERE id = $1", [entry.id]),
    );
    expect(await firstEntry(w)).toEqual(entry);
    expect(entry).toMatchObject({ amount: "100.00", balance_after: "100.00" });
    await assertGlobalInvariants(db.pool);
  });

  test("DELETE em lançamento é recusado (23001)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const entry = await firstEntry(w);
    await expectRejectedBySchema(db.pool, { code: RESTRICT_VIOLATION }, (c) =>
      c.query("DELETE FROM wallet_ledger_entries WHERE id = $1", [entry.id]),
    );
    expect(await firstEntry(w)).toEqual(entry);
    await assertGlobalInvariants(db.pool);
  });

  test("TRUNCATE do ledger é recusado (23001)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    await expectRejectedBySchema(db.pool, { code: RESTRICT_VIOLATION }, (c) =>
      c.query("TRUNCATE wallet_ledger_entries CASCADE"),
    );
    expect(await ledgerCount(w.walletId)).toBe(1);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 19 — uma transação é revertida no máximo uma vez (uq_tx_single_reversal)", () => {
  async function doubleReversal(kinds: readonly [string, string]): Promise<void> {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: UNIQUE_VIOLATION, constraint: "uq_tx_single_reversal" }, async (c) => {
      // a referência é REJECTED só para não exigir ledger nesta prova: o índice olha a reversão
      const ref = await insertTx(c, w, {
        kind: "BET",
        amount: "10.00",
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        resultBalance: "100.00",
      });
      for (const kind of kinds) {
        await insertTx(c, w, {
          kind,
          amount: "10.00",
          status: "PROCESSED",
          resultBalance: "100.00",
          referenceExternalId: ref.externalId,
          referenceTransactionId: ref.id,
        });
      }
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  }

  test("REFUND + REFUND da mesma referência", async () => {
    await doubleReversal(["REFUND", "REFUND"]);
  });

  test("REFUND + ROLLBACK da mesma referência (interpretação estrita, D7)", async () => {
    await doubleReversal(["REFUND", "ROLLBACK"]);
  });
});

describe("linha 23 — a moeda do lançamento é a da wallet (FK composta)", () => {
  test("lançamento USD numa wallet BRL é recusado por fk_ledger_wallet_currency (23503)", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    // a transação USD existe (no gabarito a moeda da transação não tem FK, para que um
    // REJECTED/CURRENCY_MISMATCH seja auditável), então só a FK (wallet_id, currency) do ledger recusa
    await expectRejectedBySchema(
      db.pool,
      { code: FOREIGN_KEY_VIOLATION, constraint: "fk_ledger_wallet_currency" },
      async (c) => {
        const tx = await insertTx(c, w, { kind: "WIN", amount: "10.00", status: "PENDING", currency: "USD" });
        await insertLedger(c, w, {
          txId: tx.id,
          direction: "CREDIT",
          amount: "10.00",
          before: "100.00",
          after: "110.00",
          version: 2,
          currency: "USD",
        });
        await c.query("UPDATE wallets SET balance_amount = 110.00, version = 2 WHERE id = $1", [w.walletId]);
      },
    );
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 24 — uma wallet por player + moeda (uq_wallet_player_currency)", () => {
  test("segunda wallet BRL do mesmo player é recusada", async () => {
    const w = await openWalletBySql(db.pool, "0.00");
    await expectRejectedBySchema(db.pool, { code: UNIQUE_VIOLATION, constraint: "uq_wallet_player_currency" }, (c) =>
      c.query("INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 0, 1)", [
        randomUUID(),
        w.playerId,
      ]),
    );
    const res = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM wallets WHERE player_id = $1", [w.playerId]);
    expect(res.rows[0]?.n).toBe(1);
    await assertGlobalInvariants(db.pool);
  });

  test("o mesmo player pode ter uma wallet em OUTRA moeda (modelo multi-moeda)", async () => {
    const brlWallet = await openWalletBySql(db.pool, "10.00");
    const usdWallet = await openWalletBySql(db.pool, "5.00", { currency: "USD", playerId: brlWallet.playerId });
    const res = await db.pool.query<{ currency: string; balance_amount: string }>(
      "SELECT currency, balance_amount FROM wallets WHERE player_id = $1 ORDER BY currency",
      [brlWallet.playerId],
    );
    expect(res.rows).toEqual([
      { currency: "BRL", balance_amount: "10.00" },
      { currency: "USD", balance_amount: "5.00" },
    ]);
    expect(usdWallet.walletId).not.toBe(brlWallet.walletId);
    await assertGlobalInvariants(db.pool);
  });
});

describe("linha 26 — version nasce 1 e só sobe (de 1 em 1) quando o saldo muda", () => {
  test("wallet criada com version 2 é recusada", async () => {
    const playerId = randomUUID();
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, (c) =>
      c.query("INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 0, 2)", [
        randomUUID(),
        playerId,
      ]),
    );
    const res = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM wallets WHERE player_id = $1", [playerId]);
    expect(res.rows[0]?.n).toBe(0);
    await assertGlobalInvariants(db.pool);
  });

  test("incrementar version sem mudar o saldo é recusado", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, (c) =>
      c.query("UPDATE wallets SET version = version + 1 WHERE id = $1", [w.walletId]),
    );
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("mudança de saldo que pula versão (v1 → v3) é recusada mesmo com lançamento", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const before = await snapshot(w);
    await expectRejectedBySchema(db.pool, { code: CHECK_VIOLATION, at: "commit" }, async (c) => {
      const tx = await insertTx(c, w, { kind: "WIN", amount: "10.00", status: "PENDING" });
      await insertLedger(c, w, { txId: tx.id, direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00", version: 3 });
      await c.query("UPDATE wallets SET balance_amount = 110.00, version = 3 WHERE id = $1", [w.walletId]);
    });
    expect(await snapshot(w)).toEqual(before);
    await assertGlobalInvariants(db.pool);
  });

  test("caminho legítimo: crédito com lançamento v2 é aceito e a versão vai a 2", async () => {
    const w = await openWalletBySql(db.pool, "100.00");
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      const tx = await insertTx(c, w, { kind: "WIN", amount: "10.00", status: "PROCESSED", resultBalance: "110.00" });
      await c.query("UPDATE wallets SET balance_amount = 110.00, version = 2 WHERE id = $1", [w.walletId]);
      await insertLedger(c, w, { txId: tx.id, direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00", version: 2 });
      await insertOutbox(c, w.walletId, "WagerTransactionProcessed", tx.id);
      await insertOutbox(c, w.walletId, "WalletBalanceChanged", tx.id);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
    expect(await walletRow(db.pool, w.walletId)).toEqual({ balance_amount: "110.00", version: 2 });
    expect(await ledgerCount(w.walletId)).toBe(2);
    await assertGlobalInvariants(db.pool);
  });
});
