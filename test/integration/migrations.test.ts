/**
 * Migrator do MikroORM rodando sob Bun contra o PostgreSQL REAL, num banco descartável:
 * round-trip up → down → up registrado na tabela de controle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { MIGRATIONS_TABLE } from "../../src/infrastructure/persistence/mikro-orm.config";
import { initOrm, migrateDown, migrateUp, type Orm } from "../../src/infrastructure/persistence/orm";
import { migrationsList } from "../../migrations";
import { createScratchDatabase, query } from "../support/postgres";

const base = loadConfig();
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let orm: Orm;

beforeAll(async () => {
  scratch = await createScratchDatabase(base.databaseUrl);
  orm = await initOrm({ ...base, databaseUrl: scratch.url });
});

afterAll(async () => {
  await orm?.close(true);
  await scratch?.drop();
});

async function recorded(): Promise<string[]> {
  const rows = await query<{ name: string }>(scratch.url, `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  return rows.map((r) => r.name);
}

describe("migrations (MikroORM Migrator programático)", () => {
  test("round-trip up → down → up", async () => {
    const all = migrationsList.map((m) => m.name);
    expect(all.length).toBeGreaterThan(0);

    const up1 = await migrateUp(orm);
    expect(up1.applied).toEqual(all);
    expect(await recorded()).toEqual(all);

    const again = await migrateUp(orm);
    expect(again.applied).toEqual([]);

    const down = await migrateDown(orm, true);
    expect(down.applied).toEqual([...all].reverse());
    expect(await recorded()).toEqual([]);

    const up2 = await migrateUp(orm);
    expect(up2.applied).toEqual(all);
    expect(await recorded()).toEqual(all);
  });
});
