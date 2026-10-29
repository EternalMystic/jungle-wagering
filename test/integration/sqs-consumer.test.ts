/**
 * INTEGRAÇÃO — consumer SQS (§10, D9) contra o processo REAL (`bun run src/main.ts`), o
 * PostgreSQL do compose e o emulador SQS reais. Nada mockado: a mensagem entra pela fila,
 * o efeito é conferido no banco e na fila/DLQ, e todo caso termina com `assertGlobalInvariants`.
 *
 * Linhas da matriz: 11 (ack só após commit: kill em after-commit-before-ack), 12 (redelivery
 * 3× sem duplicar, pela inbox), 13 (negócio → ack; transitório → retry com backoff e
 * recuperação; permanente → DLQ explícita com motivo; 5 recebimentos → DLQ pela redrive).
 *
 * Os tempos do consumer são encurtados por env (backoff 1–2 s, long poll 1 s, lock_timeout 1 s)
 * para a redrive acontecer em segundos; a semântica é a mesma dos defaults de produção.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Cluster, type Env, type WagerQueueMessage, eventually } from "../support/cluster";
import { countLockWaiters } from "../support/concurrency";
import { REPO_ROOT, type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { inboxRows, ledgerOf, outboxEventTypes, transactionByKey, walletState } from "../support/db-queries";
import { brl, newPlayerId, openWalletViaApi } from "../support/http-client";
import { assertGlobalInvariants } from "../support/invariants";

const FAST_CONSUMER: Env = {
  SQS_WAIT_TIME_SECONDS: "1",
  SQS_RETRY_BASE_SECONDS: "1",
  SQS_RETRY_MAX_SECONDS: "2",
  LOCK_TIMEOUT_MS: "1000",
  DB_SOCKET_TIMEOUT_MS: "3000",
  DB_CONNECT_TIMEOUT_MS: "1500",
  DB_ACQUIRE_TIMEOUT_MS: "3000",
};

let db: IsolatedDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase("sqs_consumer");
  cluster = await Cluster.start({ databaseUrl: db.url, tag: "sqscons", instances: 1, env: FAST_CONSUMER });
}, 120_000);

afterAll(async () => {
  await cluster?.dispose();
  await db?.drop();
}, 60_000);

interface ConsumerLog {
  msg: string;
  messageId?: string;
  sqsMessageId?: string;
  receiveCount?: number;
  status?: string;
  failureCode?: string;
  idempotentReplay?: boolean;
  transient?: boolean;
  reason?: string;
  error?: string;
}

/** Linhas JSON do consumer (log estruturado) da instância. */
function consumerLogs(c: Cluster, index = 0): ConsumerLog[] {
  return c
    .instance(index)
    .logs()
    .split("\n")
    .filter((line) => line.includes('"component":"sqs-consumer"'))
    .map((line) => JSON.parse(line) as ConsumerLog);
}

function wagerMessage(walletId: string, playerId: string, ext: string, amount: string, messageId = `msg-${randomUUID()}`): WagerQueueMessage {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId,
      walletId,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: brl(amount),
    },
  };
}

/** Envio cru: corpo arbitrário e `MessageDeduplicationId` próprio (o SQS reentrega/duplica). */
async function sendRaw(c: Cluster, body: string, groupId: string, dedupId: string = randomUUID()): Promise<void> {
  await c.sqs.send(
    new SendMessageCommand({
      QueueUrl: c.queues.wagerTransactions.url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

async function waitQueueEmpty(c: Cluster, what: string, timeoutMs = 30_000): Promise<void> {
  await eventually(what, () => c.queueDepth(c.queues.wagerTransactions.url), (depth) => depth === 0, timeoutMs, 300);
}

/**
 * Espera `expected` mensagens na DLQ e as CONSOME (lê com atributos e apaga). Apagar é
 * necessário: a DLQ é FIFO e os venenos de uma wallet dividem o `MessageGroupId`; uma mensagem
 * lida e não apagada trava o grupo, e sobras contaminariam os testes seguintes.
 */
async function readDlq(c: Cluster, expected: number, timeoutMs = 30_000): Promise<Message[]> {
  const url = c.queues.wagerTransactionsDlq.url;
  await eventually(`DLQ deveria ter ${expected} mensagem(ns)`, () => c.queueDepth(url), (n) => n >= expected, timeoutMs, 200);
  const seen = new Map<string, Message>();
  await eventually(
    `deveria ler ${expected} mensagem(ns) da DLQ`,
    async () => {
      const res = await c.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"],
          AttributeNames: ["All"],
        }),
      );
      for (const m of res.Messages ?? []) {
        seen.set(m.MessageId ?? randomUUID(), m);
        await c.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
      }
      return seen.size;
    },
    (n) => n >= expected,
    timeoutMs,
    0,
  );
  return [...seen.values()];
}

async function docker(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker compose ${args.join(" ")} saiu ${code}: ${await new Response(proc.stderr).text()}`);
}

describe("consumer SQS — negócio, redelivery e inbox", () => {
  test("mensagem §10 → mesmo use case do HTTP: efeito + inbox no commit, depois DeleteMessage", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const msg = wagerMessage(walletId, player, "sqs-bet-1", "25.00");
    await cluster.sendWagerMessage(msg);

    await waitQueueEmpty(cluster, "a mensagem deveria ser processada e apagada");
    const tx = await transactionByKey(db.pool, "provider-a:sqs-bet-1");
    expect(tx).toMatchObject({ kind: "BET", status: "PROCESSED", result_balance_amount: "75.00" });
    expect(await inboxRows(db.pool, msg.messageId)).toEqual([
      { consumer_name: "wager-transactions-consumer", processed_at: expect.any(String) },
    ]);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "75.00", version: 2 });
    expect(await outboxEventTypes(db.pool, tx?.id ?? "")).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(await cluster.queueDepth(cluster.queues.wagerTransactionsDlq.url)).toBe(0);
    await assertGlobalInvariants(db.pool);
  }, 60_000);

  test("redelivery 3× (mesmo messageId, entregas distintas do SQS) → 1 débito, 1 inbox, 2 replays reconhecidos", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const msg = wagerMessage(walletId, player, "sqs-redelivery", "10.00");
    // três entregas físicas da MESMA mensagem lógica (dedup do FIFO não as junta: ids distintos)
    for (let i = 0; i < 3; i++) await sendRaw(cluster, JSON.stringify(msg), walletId);

    await waitQueueEmpty(cluster, "as 3 entregas deveriam ser apagadas");
    const processed = consumerLogs(cluster).filter((l) => l.msg === "sqs message processed" && l.messageId === msg.messageId);
    expect(processed.map((l) => l.idempotentReplay)).toEqual([false, true, true]);
    expect(new Set(processed.map((l) => l.status))).toEqual(new Set(["PROCESSED"]));

    expect(await inboxRows(db.pool, msg.messageId)).toHaveLength(1);
    expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(1);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
    const tx = await transactionByKey(db.pool, "provider-a:sqs-redelivery");
    expect(await outboxEventTypes(db.pool, tx?.id ?? "")).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await assertGlobalInvariants(db.pool);
  }, 60_000);

  test("rejeição de negócio (saldo insuficiente) e WALLET_NOT_FOUND são terminais: commit → ack, nada na DLQ", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("5.00"));
    const poor = wagerMessage(walletId, player, "sqs-poor", "50.00");
    const ghostWallet = randomUUID();
    const ghost = wagerMessage(ghostWallet, player, "sqs-ghost", "1.00");
    await cluster.sendWagerMessage(poor);
    await cluster.sendWagerMessage(ghost);

    await waitQueueEmpty(cluster, "rejeições de negócio deveriam ser ack");
    expect(await transactionByKey(db.pool, "provider-a:sqs-poor")).toMatchObject({
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
      result_balance_amount: "5.00",
    });
    expect(await transactionByKey(db.pool, "provider-a:sqs-ghost")).toBeUndefined();
    expect(await inboxRows(db.pool, poor.messageId)).toHaveLength(1);
    expect(await inboxRows(db.pool, ghost.messageId)).toHaveLength(1);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "5.00", version: 1 });
    expect(await cluster.queueDepth(cluster.queues.wagerTransactionsDlq.url)).toBe(0);
    await assertGlobalInvariants(db.pool);
  }, 60_000);
});

describe("consumer SQS — permanente → DLQ explícita", () => {
  test("JSON inválido, schema inválido, conflito de idempotência e messageId com outro payload: DLQ no 1º recebimento, com motivo", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const original = wagerMessage(walletId, player, "sqs-perm-original", "10.00");
    await cluster.sendWagerMessage(original);
    await waitQueueEmpty(cluster, "a mensagem original deveria ser processada");

    const invalidMoney = wagerMessage(walletId, player, "sqs-perm-1e3", "1.00");
    const conflict = { ...wagerMessage(walletId, player, "sqs-perm-original", "99.00"), messageId: `msg-${randomUUID()}` };
    const sameIdOtherPayload = { ...wagerMessage(walletId, player, "sqs-perm-other", "7.00"), messageId: original.messageId };
    await sendRaw(cluster, "{definitely not json", walletId);
    await sendRaw(cluster, JSON.stringify({ ...invalidMoney, data: { ...invalidMoney.data, money: { amount: "1e3", currency: "BRL" } } }), walletId);
    await sendRaw(cluster, JSON.stringify(conflict), walletId);
    await sendRaw(cluster, JSON.stringify(sameIdOtherPayload), walletId);

    const dead = await readDlq(cluster, 4);
    await waitQueueEmpty(cluster, "venenos não podem ficar na fila principal");
    const reasons = dead.map((m) => m.MessageAttributes?.reason?.StringValue).sort();
    expect(reasons).toEqual(["IDEMPOTENCY_CONFLICT", "INBOX_PAYLOAD_MISMATCH", "INVALID_JSON", "INVALID_PAYLOAD"]);
    // explícita (não a redrive): cada um saiu no PRIMEIRO recebimento
    expect(dead.map((m) => m.MessageAttributes?.receiveCount?.StringValue)).toEqual(["1", "1", "1", "1"]);
    expect(dead.map((m) => m.Body)).toContain("{definitely not json");

    // nada dos venenos tocou o banco; a inbox do original continua com o payload ORIGINAL
    expect(await transactionByKey(db.pool, "provider-a:sqs-perm-1e3")).toBeUndefined();
    expect(await transactionByKey(db.pool, "provider-a:sqs-perm-other")).toBeUndefined();
    expect(await transactionByKey(db.pool, "provider-a:sqs-perm-original")).toMatchObject({ amount: "10.00", status: "PROCESSED" });
    expect(await inboxRows(db.pool, conflict.messageId)).toHaveLength(0);
    expect(await inboxRows(db.pool, original.messageId)).toHaveLength(1);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
    await assertGlobalInvariants(db.pool);
  }, 90_000);
});

describe("consumer SQS — transitório", () => {
  test("lock da wallet preso além do lock_timeout em toda tentativa → retry com backoff, 5 recebimentos → DLQ pela redrive", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const msg = wagerMessage(walletId, player, "sqs-stuck", "10.00");

    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [walletId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? -1;
      await cluster.sendWagerMessage(msg);

      // prova de disputa: o consumer está DENTRO do banco esperando o lock da wallet
      await eventually("o consumer deveria esperar o lock da wallet", () => countLockWaiters(db.pool, holderPid), (n) => n >= 1, 15_000, 100);

      const dead = await readDlq(cluster, 1, 60_000);
      expect(dead[0]?.Body).toBe(JSON.stringify(msg));
      // veio da RedrivePolicy (sem atributo de motivo do consumer), não da DLQ explícita
      expect(dead[0]?.MessageAttributes?.reason).toBeUndefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    const retries = consumerLogs(cluster).filter((l) => l.msg === "sqs message will be retried" && l.messageId === msg.messageId);
    expect(retries.map((l) => l.receiveCount)).toEqual([1, 2, 3, 4, 5]);
    expect(retries.every((l) => l.transient === true)).toBe(true);
    await waitQueueEmpty(cluster, "a redrive deveria tirar a mensagem da fila principal");

    // cada tentativa foi desfeita por inteiro: nada confirmado, nem a inbox
    expect(await transactionByKey(db.pool, "provider-a:sqs-stuck")).toBeUndefined();
    expect(await inboxRows(db.pool, msg.messageId)).toHaveLength(0);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "100.00", version: 1 });
    await assertGlobalInvariants(db.pool);
  }, 120_000);

  test("Postgres pausado (docker compose pause) → retry transitório; unpause → processa uma vez", async () => {
    const player = newPlayerId();
    const walletId = await openWalletViaApi(cluster.api(0), player, brl("100.00"));
    const msg = wagerMessage(walletId, player, "sqs-pg-paused", "30.00");
    const retried = () => consumerLogs(cluster).filter((l) => l.msg === "sqs message will be retried" && l.messageId === msg.messageId);

    await docker("pause", "postgres");
    try {
      await cluster.sendWagerMessage(msg);
      await eventually("o consumer deveria falhar transitoriamente com o banco congelado", async () => retried().length, (n) => n >= 1, 30_000, 200);
    } finally {
      await docker("unpause", "postgres");
    }

    await waitQueueEmpty(cluster, "depois do unpause a mensagem deveria ser processada", 60_000);
    expect(retried().length).toBeGreaterThanOrEqual(1);
    expect(retried().filter((l) => l.transient !== true)).toEqual([]);
    const processed = consumerLogs(cluster).filter((l) => l.msg === "sqs message processed" && l.messageId === msg.messageId);
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({ status: "PROCESSED", idempotentReplay: false });

    expect(await inboxRows(db.pool, msg.messageId)).toHaveLength(1);
    expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(1);
    expect(await walletState(db.pool, walletId)).toEqual({ balance: "70.00", version: 2 });
    expect(await cluster.queueDepth(cluster.queues.wagerTransactionsDlq.url)).toBe(0);
    await assertGlobalInvariants(db.pool);
  }, 120_000);
});

describe("consumer SQS — ack só após commit", () => {
  test("SIGKILL em after-commit-before-ack: efeito confirmado, mensagem volta; processo novo reconhece pela inbox e apaga", async () => {
    const crashing = await Cluster.start({
      databaseUrl: db.url,
      tag: "sqscrash",
      instances: 1,
      // visibilidade curta só para a reentrega vir em segundos
      env: { ...FAST_CONSUMER, SQS_VISIBILITY_TIMEOUT_SECONDS: "5" },
      envFor: () => ({ FAULT_POINT: "after-commit-before-ack" }),
    });
    try {
      const player = newPlayerId();
      const walletId = await openWalletViaApi(crashing.api(0), player, brl("100.00"));
      const msg = wagerMessage(walletId, player, "sqs-crash", "10.00");
      await crashing.sendWagerMessage(msg);
      await crashing.waitForExit(0, 20_000, "o consumer deveria morrer em after-commit-before-ack");

      expect(await transactionByKey(db.pool, "provider-a:sqs-crash")).toMatchObject({ status: "PROCESSED", result_balance_amount: "90.00" });
      expect(await inboxRows(db.pool, msg.messageId)).toHaveLength(1);
      expect(await crashing.queueDepth(crashing.queues.wagerTransactions.url)).toBe(1);

      await crashing.restart(0, { FAULT_POINT: "" });
      await waitQueueEmpty(crashing, "a reentrega deveria ser reconhecida e apagada", 45_000);
      const replay = consumerLogs(crashing).filter((l) => l.msg === "sqs message processed" && l.messageId === msg.messageId);
      expect(replay).toEqual([expect.objectContaining({ status: "PROCESSED", idempotentReplay: true, receiveCount: 2 })]);

      expect((await ledgerOf(db.pool, walletId)).filter((l) => l.direction === "DEBIT")).toHaveLength(1);
      expect(await walletState(db.pool, walletId)).toEqual({ balance: "90.00", version: 2 });
      expect(await crashing.queueDepth(crashing.queues.wagerTransactionsDlq.url)).toBe(0);
      await assertGlobalInvariants(db.pool);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- logs ---\n${crashing.logs()}`, { cause: error });
    } finally {
      await crashing.dispose();
    }
  }, 120_000);
});
