/**
 * Prova executável do schema de referência contra um PostgreSQL REAL.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5432/postgres bun run verify-schema.ts
 *
 * O script cria um banco descartável, aplica sql/001_schema.sql e então:
 *   1. ATAQUES   — tenta violar cada garantia por SQL cru; cada um TEM de falhar
 *                  com o SQLSTATE esperado. (Isto prova que a garantia é do banco.)
 *   2. SABOTAGEM — executa o anti-padrão read → calculate → update sem lock e
 *                  mostra que o banco recusa o lost update.
 *   3. CORRIDAS  — cenário da seção 8 (100 − 80 ∥ 80) e 50 BETs idênticas em
 *                  paralelo, com conexões distintas (concorrência real no Postgres).
 *   4. INVARIANTES — roda sql/invariants.sql; todas as queries devem voltar vazias.
 *
 * Não é o teste do projeto: é o "gabarito" do comportamento do schema que a
 * migration do MikroORM precisa reproduzir. Porte os casos para test/integration.
 */
import { Client, Pool, type PoolClient } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB_NAME = `wagering_verify_${Date.now()}`;
const here = import.meta.dir;

let failures = 0;
const ok = (msg: string) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  \x1b[31m✘ ${msg}\x1b[0m`);
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

// ---------------------------------------------------------------- helpers SQL
async function openWallet(c: Client | PoolClient, balance: string, currency = "BRL") {
  const walletId = randomUUID();
  const playerId = randomUUID();
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1,$2,$3,$4,1)`,
    [walletId, playerId, currency, balance],
  );
  if (balance !== "0.00") {
    const txId = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          kind, amount, currency, status, result_balance_amount, correlation_id, resolved_at)
       VALUES ($1,'internal',$2,$3,$4,$5,$6,'OPENING',$7,$8,'PROCESSED',$7,$9, now())`,
      [txId, `opening-${walletId}`, `internal:opening-${walletId}`, sha(walletId), walletId, playerId, balance, currency, randomUUID()],
    );
    await c.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
       VALUES ($1,$2,$3,$4,'CREDIT',$5,0,$5,1)`,
      [randomUUID(), walletId, txId, currency, balance],
    );
  }
  await c.query("COMMIT");
  return { walletId, playerId };
}

type BetResult = { status: "PROCESSED" | "REJECTED" | "REPLAY" | "CONFLICT"; balance: string };

/**
 * Algoritmo de referência do caminho crítico (o que o use case deve fazer):
 *   BEGIN
 *     SELECT wallet ... FOR UPDATE          -- serializa POR WALLET (não global)
 *     SELECT tx por idempotency_key          -- replay/conflito, já sob o lock
 *     INSERT tx (PENDING)                    -- UNIQUE é o backstop
 *     UPDATE wallet ... WHERE version = $v AND balance >= $amt  -- update condicionado
 *     INSERT ledger
 *     UPDATE tx -> PROCESSED/REJECTED (+ saldo observado)
 *     INSERT outbox
 *   COMMIT                                   -- triggers diferidos validam aqui
 * 23505 em idempotency_key (chave reaproveitada em OUTRA wallet) ⇒ ROLLBACK e reler.
 */
async function placeBet(
  pool: Pool,
  w: { walletId: string; playerId: string },
  amount: string,
  externalId: string,
): Promise<BetResult> {
  const c = await pool.connect();
  const idemKey = `provider-a:${externalId}`;
  const payloadHash = sha(JSON.stringify({ amount, externalId, walletId: w.walletId }));
  try {
    await c.query("BEGIN");
    const { rows: [wallet] } = await c.query(
      `SELECT balance_amount, version FROM wallets WHERE id = $1 FOR UPDATE`, [w.walletId]);

    const { rows: [existing] } = await c.query(
      `SELECT payload_hash, status, result_balance_amount FROM wager_transactions WHERE idempotency_key = $1`, [idemKey]);
    if (existing) {
      await c.query("ROLLBACK");
      return existing.payload_hash === payloadHash
        ? { status: "REPLAY", balance: existing.result_balance_amount }
        : { status: "CONFLICT", balance: wallet.balance_amount };
    }

    const txId = randomUUID();
    const corr = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'provider-a',$2,$3,$4,$5,$6,'round-1','fortune-chimp','BET',$7,'BRL','PENDING',$8)`,
      [txId, externalId, idemKey, payloadHash, w.walletId, w.playerId, amount, corr]);

    // update atômico condicionado: a comparação de saldo é feita PELO BANCO, em NUMERIC
    const upd = await c.query(
      `UPDATE wallets
          SET balance_amount = balance_amount - $2::numeric, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $3 AND balance_amount >= $2::numeric
        RETURNING balance_amount, version`,
      [w.walletId, amount, wallet.version]);

    if (upd.rowCount === 0) {
      await c.query(
        `UPDATE wager_transactions SET status='REJECTED', failure_code='INSUFFICIENT_FUNDS',
                result_balance_amount=$2, resolved_at=now() WHERE id=$1`,
        [txId, wallet.balance_amount]);
      await c.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
         VALUES ($1,$2,'WagerTransactionRejected',1,$3,now())`,
        [randomUUID(), w.walletId, JSON.stringify({ data: { transactionId: txId, failureCode: "INSUFFICIENT_FUNDS" } })]);
      await c.query("COMMIT");
      return { status: "REJECTED", balance: wallet.balance_amount };
    }

    const after = upd.rows[0];
    await c.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
       VALUES ($1,$2,$3,'BRL','DEBIT',$4,$5,$6,$7)`,
      [randomUUID(), w.walletId, txId, amount, wallet.balance_amount, after.balance_amount, after.version]);
    await c.query(
      `UPDATE wager_transactions SET status='PROCESSED', result_balance_amount=$2, resolved_at=now() WHERE id=$1`,
      [txId, after.balance_amount]);
    for (const type of ["WagerTransactionProcessed", "WalletBalanceChanged"]) {
      await c.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
         VALUES ($1,$2,$3,1,$4,now())`,
        [randomUUID(), w.walletId, type, JSON.stringify({ data: { transactionId: txId } })]);
    }
    await c.query("COMMIT");
    return { status: "PROCESSED", balance: after.balance_amount };
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    if (e.code === "23505") {
      // corrida perdida no UNIQUE: o vencedor já commitou; reler e devolver replay/conflito
      const { rows: [existing] } = await pool.query(
        `SELECT payload_hash, result_balance_amount FROM wager_transactions WHERE idempotency_key = $1`, [idemKey]);
      return existing.payload_hash === payloadHash
        ? { status: "REPLAY", balance: existing.result_balance_amount }
        : { status: "CONFLICT", balance: "?" };
    }
    throw e;
  } finally {
    c.release();
  }
}

/** Executa `fn` numa transação e exige que ela falhe com o SQLSTATE `code` (no statement ou no COMMIT). */
async function expectFail(c: Client, label: string, code: string, fn: () => Promise<unknown>) {
  try {
    await c.query("BEGIN");
    await fn();
    await c.query("COMMIT"); // triggers diferidos disparam aqui
    bad(`${label} — o banco ACEITOU (esperado SQLSTATE ${code})`);
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    if (e.code === code) ok(`${label} → bloqueado (${code})`);
    else bad(`${label} — falhou com ${e.code} (${e.message}), esperado ${code}`);
  }
}

// ---------------------------------------------------------------------- main
async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);

  const c = new Client({ connectionString: dbUrl(DB_NAME) });
  await c.connect();
  await c.query(readFileSync(join(here, "sql/001_schema.sql"), "utf8"));
  console.log(`\nschema aplicado em ${DB_NAME}\n`);

  const pool = new Pool({ connectionString: dbUrl(DB_NAME), max: 60 });

  // ------------------------------------------------------------- 1. ataques
  console.log("1. Ataques diretos ao schema (cada um precisa falhar)");
  const w = await openWallet(c, "100.00");
  const { rows: [opening] } = await c.query(`SELECT id FROM wager_transactions WHERE wallet_id=$1`, [w.walletId]);
  const { rows: [entry] } = await c.query(`SELECT id FROM wallet_ledger_entries WHERE wallet_id=$1`, [w.walletId]);

  await expectFail(c, "saldo negativo na wallet", "23514", () =>
    c.query(`UPDATE wallets SET balance_amount = -1 WHERE id=$1`, [w.walletId]));
  await expectFail(c, "segunda wallet para o mesmo player+moeda", "23505", () =>
    c.query(`INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1,$2,'BRL',0,1)`,
      [randomUUID(), w.playerId]));
  await expectFail(c, "wallet aberta com saldo sem lançamento OPENING", "23514", () =>
    c.query(`INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1,$2,'BRL',50,1)`,
      [randomUUID(), randomUUID()]));
  await expectFail(c, "UPDATE no ledger", "23001", () =>
    c.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id=$1`, [entry.id]));
  await expectFail(c, "DELETE no ledger", "23001", () =>
    c.query(`DELETE FROM wallet_ledger_entries WHERE id=$1`, [entry.id]));
  await expectFail(c, "TRUNCATE no ledger", "23001", () => c.query(`TRUNCATE wallet_ledger_entries CASCADE`));
  await expectFail(c, "alterar saldo sem lançamento (lost ledger)", "23514", () =>
    c.query(`UPDATE wallets SET balance_amount = 90, version = version + 1 WHERE id=$1`, [w.walletId]));
  await expectFail(c, "incrementar version sem mudar saldo", "23514", () =>
    c.query(`UPDATE wallets SET version = version + 1 WHERE id=$1`, [w.walletId]));
  await expectFail(c, "lançamento órfão (wallet não acompanha)", "23514", async () => {
    const tx = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'p','orphan','p:orphan',$2,$3,$4,'r','g','WIN',10,'BRL','PENDING','c')`,
      [tx, sha("o"), w.walletId, w.playerId]);
    await c.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount,
         balance_before, balance_after, wallet_version) VALUES ($1,$2,$3,'BRL','CREDIT',10,100,110,2)`,
      [randomUUID(), w.walletId, tx]);
  });
  await expectFail(c, "aritmética do lançamento errada (100 + 10 = 120)", "23514", async () => {
    const tx = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'p','arith','p:arith',$2,$3,$4,'r','g','WIN',10,'BRL','PENDING','c')`,
      [tx, sha("a"), w.walletId, w.playerId]);
    await c.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount,
         balance_before, balance_after, wallet_version) VALUES ($1,$2,$3,'BRL','CREDIT',10,100,120,2)`,
      [randomUUID(), w.walletId, tx]);
  });
  await expectFail(c, "lançamento em moeda diferente da wallet", "23503", async () => {
    const tx = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'p','usd','p:usd',$2,$3,$4,'r','g','WIN',10,'USD','PENDING','c')`,
      [tx, sha("u"), w.walletId, w.playerId]);
    await c.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount,
         balance_before, balance_after, wallet_version) VALUES ($1,$2,$3,'USD','CREDIT',10,100,110,2)`,
      [randomUUID(), w.walletId, tx]);
  });
  await expectFail(c, "dois lançamentos para a mesma transação/wallet", "23505", () =>
    c.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount,
         balance_before, balance_after, wallet_version) VALUES ($1,$2,$3,'BRL','CREDIT',100,100,200,2)`,
      [randomUUID(), w.walletId, opening.id]));
  await expectFail(c, "idempotency key duplicada", "23505", () =>
    c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'internal','other',$2,$3,$4,$5,'OPENING',1,'BRL','PENDING','c')`,
      [randomUUID(), `internal:opening-${w.walletId}`, sha("x"), w.walletId, w.playerId]));
  await expectFail(c, "transação terminal mudando de estado", "23001", () =>
    c.query(`UPDATE wager_transactions SET status='REJECTED', failure_code='X' WHERE id=$1`, [opening.id]));
  await expectFail(c, "DELETE de transação", "23001", () =>
    c.query(`DELETE FROM wager_transactions WHERE id=$1`, [opening.id]));
  await expectFail(c, "REFUND sem referência", "23514", () =>
    c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id)
       VALUES ($1,'p','rf','p:rf',$2,$3,$4,'r','g','REFUND',10,'BRL','PENDING','c')`,
      [randomUUID(), sha("r"), w.walletId, w.playerId]));
  await expectFail(c, "REJECTED sem failure_code", "23514", () =>
    c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance_amount,
         correlation_id, resolved_at)
       VALUES ($1,'p','rj','p:rj',$2,$3,$4,'r','g','BET',10,'BRL','REJECTED',100,'c',now())`,
      [randomUUID(), sha("j"), w.walletId, w.playerId]));
  await expectFail(c, "mesma BET revertida duas vezes (REFUND + ROLLBACK)", "23505", async () => {
    const bet = randomUUID();
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code,
         result_balance_amount, correlation_id, resolved_at)
       VALUES ($1,'p','b1','p:b1',$2,$3,$4,'r','g','BET',10,'BRL','REJECTED','INSUFFICIENT_FUNDS',100,'c',now())`,
      [bet, sha("b"), w.walletId, w.playerId]);
    // (status REJECTED só para não exigir ledger nesta prova; o índice olha a reversão, não a BET)
    for (const [kind, ext] of [["REFUND", "rf1"], ["ROLLBACK", "rb1"]] as const) {
      await c.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
           reference_transaction_id, status, result_balance_amount, correlation_id, resolved_at)
         VALUES ($1,'p',$2,$3,$4,$5,$6,'r','g',$7,10,'BRL','b1',$8,'PROCESSED',100,'c',now())`,
        [randomUUID(), ext, `p:${ext}`, sha(ext), w.walletId, w.playerId, kind, bet]);
    }
  });
  await expectFail(c, "evento da outbox reescrito", "23001", async () => {
    const id = randomUUID();
    await c.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
                   VALUES ($1,$2,'X',1,'{"a":1}',now())`, [id, w.walletId]);
    await c.query(`UPDATE outbox_messages SET payload='{"a":2}' WHERE id=$1`, [id]);
  });

  // armadilha que o schema NÃO cobre — por isso Money é o portão
  const { rows: [r] } = await c.query(`SELECT '10.005'::numeric(20,2) AS v`);
  console.log(`  \x1b[33m!\x1b[0m armadilha: '10.005'::numeric(20,2) = ${r.v} (Postgres ARREDONDA em silêncio;`
    + ` Money.from deve rejeitar >2 casas ANTES do banco)`);

  // ------------------------------------------------------------ 2. sabotagem
  console.log("\n2. Sabotagem: read → calculate → update SEM lock, duas apostas de 80 sobre 100");
  {
    const sw = await openWallet(c, "100.00");
    const naive = async (ext: string) => {
      const k = await pool.connect();
      try {
        await k.query("BEGIN");
        const { rows: [wal] } = await k.query(`SELECT balance_amount, version FROM wallets WHERE id=$1`, [sw.walletId]); // sem FOR UPDATE
        await Bun.sleep(50); // janela de corrida escancarada
        const newBal = (Number(wal.balance_amount) - 80).toFixed(2); // o pecado duplo: number + sem lock
        if (Number(newBal) < 0) { await k.query("ROLLBACK"); return "rejected-in-app"; }
        const tx = randomUUID();
        await k.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance_amount,
             correlation_id, resolved_at)
           VALUES ($1,'p',$2,$3,$4,$5,$6,'r','g','BET',80,'BRL','PROCESSED',$7,'c',now())`,
          [tx, ext, `p:${ext}`, sha(ext), sw.walletId, sw.playerId, newBal]);
        await k.query(`UPDATE wallets SET balance_amount=$2, version=$3 WHERE id=$1`, [sw.walletId, newBal, wal.version + 1]);
        await k.query(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount,
             balance_before, balance_after, wallet_version) VALUES ($1,$2,$3,'BRL','DEBIT',80,$4,$5,$6)`,
          [randomUUID(), sw.walletId, tx, wal.balance_amount, newBal, wal.version + 1]);
        await k.query("COMMIT");
        return "committed";
      } catch (e: any) {
        await k.query("ROLLBACK").catch(() => {});
        return `blocked:${e.code}${e.constraint ? ":" + e.constraint : ""}`;
      } finally { k.release(); }
    };
    const res = await Promise.all([naive("n1"), naive("n2")]);
    const committed = res.filter((x) => x === "committed").length;
    const { rows: [fin] } = await c.query(`SELECT balance_amount FROM wallets WHERE id=$1`, [sw.walletId]);
    if (committed === 1 && fin.balance_amount === "20.00")
      ok(`código ingênuo: ${JSON.stringify(res)} — o banco impediu o lost update (saldo ${fin.balance_amount})`);
    else bad(`código ingênuo passou: ${JSON.stringify(res)} saldo=${fin.balance_amount}`);
  }

  // -------------------------------------------------------------- 3. corridas
  console.log("\n3. Corridas reais (conexões distintas)");
  {
    const rw = await openWallet(c, "100.00");
    const res = await Promise.all([placeBet(pool, rw, "80.00", "race-a"), placeBet(pool, rw, "80.00", "race-b")]);
    const { rows: [fin] } = await c.query(`SELECT balance_amount FROM wallets WHERE id=$1`, [rw.walletId]);
    const { rows: [deb] } = await c.query(
      `SELECT count(*)::int n FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'`, [rw.walletId]);
    const statuses = res.map((r) => r.status).sort().join(",");
    if (statuses === "PROCESSED,REJECTED" && fin.balance_amount === "20.00" && deb.n === 1)
      ok(`seção 8: ${statuses}, saldo final ${fin.balance_amount}, ${deb.n} débito`);
    else bad(`seção 8: ${statuses} saldo=${fin.balance_amount} débitos=${deb.n}`);
  }
  {
    const iw = await openWallet(c, "1000.00");
    const res = await Promise.all(Array.from({ length: 50 }, () => placeBet(pool, iw, "10.00", "same-bet")));
    const processed = res.filter((r) => r.status === "PROCESSED").length;
    const replays = res.filter((r) => r.status === "REPLAY");
    const sameBalance = replays.every((r) => r.balance === "990.00");
    const { rows: [deb] } = await c.query(
      `SELECT count(*)::int n FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'`, [iw.walletId]);
    if (processed === 1 && replays.length === 49 && sameBalance && deb.n === 1)
      ok(`50× a mesma BET em paralelo: 1 PROCESSED, 49 replays com o saldo original 990.00, 1 débito`);
    else bad(`50× BET: processed=${processed} replays=${replays.length} sameBalance=${sameBalance} débitos=${deb.n}`);
  }
  {
    const ws = [];
    for (let i = 0; i < 20; i++) { const k = await pool.connect(); ws.push(await openWallet(k, "50.00")); k.release(); }
    const t0 = performance.now();
    await Promise.all(ws.flatMap((wl, i) => [placeBet(pool, wl, "30.00", `p-${i}-a`), placeBet(pool, wl, "30.00", `p-${i}-b`)]));
    const { rows: [bad20] } = await c.query(
      `SELECT count(*)::int n FROM wallets WHERE id = ANY($1) AND balance_amount <> 20`, [ws.map((x) => x.walletId)]);
    if (bad20.n === 0) ok(`20 wallets distintas em paralelo: todas terminaram em 20.00 (${Math.round(performance.now() - t0)} ms)`);
    else bad(`${bad20.n} wallets com saldo errado`);
  }

  // ----------------------------------------------------------- 4. invariantes
  console.log("\n4. Invariantes globais (sql/invariants.sql)");
  const queries = readFileSync(join(here, "sql/invariants.sql"), "utf8")
    .split(/;\s*\n/).map((q) => q.trim()).filter((q) => /select/i.test(q));
  // I6/I7 só valem para transações criadas pelo caminho correto (placeBet, provider-a);
  // as linhas forjadas nos ataques/sabotagem não escrevem outbox de propósito.
  const { rows: real } = await c.query(`SELECT id FROM wager_transactions WHERE provider_id = 'provider-a'`);
  const realIds = new Set(real.map((x) => x.id));
  for (const q of queries) {
    const label = (q.match(/-- (I\d+\.[^\n]*)/) ?? [, "invariante"])[1]!;
    const { rows } = await c.query(q.replace(/^(--[^\n]*\n)+/, ""));
    const relevant = /^I[67]\./.test(label) ? rows.filter((x) => realIds.has(x.id ?? x.transaction_id)) : rows;
    if (relevant.length === 0) ok(label!);
    else bad(`${label}: ${JSON.stringify(relevant.slice(0, 3))}`);
  }

  await pool.end();
  await c.end();
  await admin.query(`DROP DATABASE ${DB_NAME}`);
  await admin.end();

  console.log(failures === 0 ? "\n\x1b[32mTUDO OK\x1b[0m\n" : `\n\x1b[31m${failures} FALHA(S)\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
