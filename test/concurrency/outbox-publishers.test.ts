/**
 * §13 Concorrência 6 — publishers concorrentes sobre a MESMA outbox (§11), mais a morte do
 * publisher nos dois pontos críticos (FaultInjector D20). Depende do publisher (fase 07):
 * até lá fica VERMELHO, porque nada publica.
 *
 * Contrato assumido do publisher (D10, D20): corpo da mensagem em `wallet-events.fifo` = o
 * envelope gravado em `outbox_messages.payload` (com `eventId` = id da linha); `locked_by`
 * = `INSTANCE_ID` do processo e permanece após publicar (auditoria de quem publicou).
 *
 * O backlog é semeado ANTES de as instâncias subirem, para que os dois publishers disputem
 * o mesmo conjunto desde o primeiro ciclo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@aws-sdk/client-sqs";
import { Cluster, eventually } from "../support/cluster";
import { type IsolatedDatabase, createIsolatedDatabase } from "../support/database";
import { outboxRows, seedOutboxEvents, transactionsOf } from "../support/db-queries";
import { assertGlobalInvariants } from "../support/invariants";
import { openWalletBySql } from "../support/sql-fixtures";
import { ack, receive } from "../support/sqs";

const LEASE_EXPIRY_DEADLINE_MS = 75_000; // lease de 30 s (D10) + folga de publicação

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await createIsolatedDatabase("conc_outbox");
}, 120_000);

afterAll(async () => {
  await db?.drop();
}, 60_000);

/** Backlog confirmado: `perWallet` eventos para cada uma de `wallets` wallets abertas por SQL. */
async function seedBacklog(wallets: number, perWallet: number): Promise<string[]> {
  const ids: string[] = [];
  for (let w = 0; w < wallets; w++) {
    const { walletId } = await openWalletBySql(db.pool, "100.00");
    const opening = (await transactionsOf(db.pool, walletId))[0];
    if (!opening) throw new Error("abertura sem transação OPENING");
    ids.push(...(await seedOutboxEvents(db.pool, walletId, opening.id, perWallet)));
  }
  return ids;
}

function eventIdOf(message: Message): string {
  const body: unknown = JSON.parse(message.Body ?? "null");
  if (typeof body !== "object" || body === null || !("eventId" in body) || typeof body.eventId !== "string") {
    throw new Error(`mensagem sem eventId: ${message.Body}`);
  }
  return body.eventId;
}

/** Lê (e apaga) tudo da fila de eventos até ela responder vazia 3 vezes seguidas. */
async function drainEvents(cluster: Cluster): Promise<string[]> {
  const ids: string[] = [];
  let empty = 0;
  while (empty < 3) {
    const batch = await receive(cluster.sqs, cluster.queues.walletEvents.url, 10, 1);
    if (batch.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    for (const m of batch) {
      ids.push(eventIdOf(m));
      await ack(cluster.sqs, cluster.queues.walletEvents.url, m);
    }
  }
  return ids;
}

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

const allPublished = (rows: { published_at: string | null }[]) => rows.length > 0 && rows.every((r) => r.published_at !== null);

describe("§13 concorrência 6 — dois publishers sobre a mesma outbox", () => {
  test("todo evento confirmado é publicado, nenhum perdido, e os DOIS publishers trabalharam", async () => {
    const seeded = await seedBacklog(20, 30); // 600 eventos
    await withCluster("pub2", 2, () => undefined, async (cluster) => {
      const rows = await eventually(
        "todos os eventos semeados publicados",
        () => outboxRows(db.pool, seeded),
        allPublished,
        60_000,
        500,
      );
      // SKIP LOCKED + lease: os dois processos reivindicaram partes do backlog
      expect(new Set(rows.map((r) => r.locked_by))).toEqual(new Set(cluster.instances.map((i) => i.name)));

      const received = await drainEvents(cluster);
      expect(new Set(received)).toEqual(new Set(seeded));
      // sem crash não há motivo para republicar: cada evento chega uma vez
      expect(received).toHaveLength(seeded.length);
    });
    await assertGlobalInvariants(db.pool);
  }, 150_000);

  test("publisher morto depois de reivindicar e antes de publicar: o lease expira e outra instância publica", async () => {
    const seeded = await seedBacklog(2, 5);
    await withCluster("pubclaim", 1, () => ({ FAULT_POINT: "after-claim-before-publish" }), async (cluster) => {
      const dead = cluster.instance(0).name;
      await cluster.waitForExit(0, 20_000, "o publisher deveria reivindicar o backlog e morrer em after-claim-before-publish");

      const claimed = await outboxRows(db.pool, seeded);
      expect(claimed.some((r) => r.locked_by === dead && r.published_at === null)).toBe(true);
      expect(await drainEvents(cluster)).toEqual([]);

      const fresh = await cluster.restart(0, { FAULT_POINT: "" });
      const rows = await eventually("backlog publicado após o lease expirar", () => outboxRows(db.pool, seeded), allPublished, LEASE_EXPIRY_DEADLINE_MS, 500);
      expect(new Set(rows.map((r) => r.locked_by))).toEqual(new Set([fresh.name]));
      expect(new Set(await drainEvents(cluster))).toEqual(new Set(seeded));
    });
    await assertGlobalInvariants(db.pool);
  }, 180_000);

  test("publisher morto depois de publicar e antes de marcar: republicação segura, nada perdido", async () => {
    const seeded = await seedBacklog(2, 5);
    await withCluster("pubmark", 1, () => ({ FAULT_POINT: "after-publish-before-mark" }), async (cluster) => {
      await cluster.waitForExit(0, 20_000, "o publisher deveria publicar e morrer em after-publish-before-mark");

      // já saiu para o SQS, mas o banco ainda não sabe: nenhum marcado
      expect((await outboxRows(db.pool, seeded)).every((r) => r.published_at === null)).toBe(true);

      await cluster.restart(0, { FAULT_POINT: "" });
      await eventually("backlog marcado como publicado", () => outboxRows(db.pool, seeded), allPublished, LEASE_EXPIRY_DEADLINE_MS, 500);
      // at-least-once: cada evento chega ≥ 1 vez (o consumidor deduplica por eventId)
      const received = await drainEvents(cluster);
      expect(new Set(received)).toEqual(new Set(seeded));
    });
    await assertGlobalInvariants(db.pool);
  }, 180_000);
});
