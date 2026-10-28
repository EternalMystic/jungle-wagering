/**
 * Migrator do MikroORM rodando sob Bun contra o PostgreSQL REAL, em bancos descartáveis:
 *   - round-trip up → down → up registrado na tabela de controle;
 *   - o catálogo produzido pela migration é IDÊNTICO ao do gabarito
 *     (reference/sql/001_schema.sql aplicado cru): colunas, constraints (com
 *     deferrable/deferred), índices, triggers e corpo das funções;
 *   - o down não deixa resíduo (nenhuma tabela, função ou trigger do schema).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { MIGRATIONS_TABLE } from "../../src/infrastructure/persistence/mikro-orm.config";
import { initOrm, migrateDown, migrateUp, type Orm } from "../../src/infrastructure/persistence/orm";
import { migrationsList } from "../../migrations";
import { createScratchDatabase, query } from "../support/postgres";

const base = loadConfig();
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let reference: Awaited<ReturnType<typeof createScratchDatabase>>;
let orm: Orm;

const REFERENCE_SQL = new URL("../../reference/sql/001_schema.sql", import.meta.url);

beforeAll(async () => {
  scratch = await createScratchDatabase(base.databaseUrl);
  reference = await createScratchDatabase(base.databaseUrl);
  orm = await initOrm({ ...base, databaseUrl: scratch.url });

  // gabarito aplicado exatamente como está (BEGIN/COMMIT inclusos), protocolo simples
  const c = new Client({ connectionString: reference.url });
  await c.connect();
  try {
    await c.query(readFileSync(REFERENCE_SQL, "utf8"));
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  await orm?.close(true);
  await scratch?.drop();
  await reference?.drop();
});

async function recorded(): Promise<string[]> {
  const rows = await query<{ name: string }>(scratch.url, `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  return rows.map((r) => r.name);
}

type Row = Record<string, unknown>;

/** Fotografia do catálogo do schema public (sem a tabela de controle do Migrator). */
async function catalog(url: string): Promise<Record<string, Row[]>> {
  const columns = await query<Row>(
    url,
    `SELECT table_name, column_name, ordinal_position, data_type, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> $1
      ORDER BY table_name, ordinal_position`,
    [MIGRATIONS_TABLE],
  );
  const constraints = await query<Row>(
    url,
    `SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype,
            c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conrelid::regclass::text <> $1
      ORDER BY 1, 2`,
    [MIGRATIONS_TABLE],
  );
  const indexes = await query<Row>(
    url,
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> $1
      ORDER BY 1, 2`,
    [MIGRATIONS_TABLE],
  );
  const triggers = await query<Row>(
    url,
    `SELECT t.tgrelid::regclass::text AS table_name, t.tgname, t.tgdeferrable, t.tginitdeferred,
            pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
      WHERE NOT t.tgisinternal
      ORDER BY 1, 2`,
  );
  const functions = (
    await query<Row & { src: string }>(
      url,
      `SELECT p.proname, pg_get_function_arguments(p.oid) AS args, l.lanname, p.prorettype::regtype::text AS ret,
              p.prosrc AS src
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public'
        ORDER BY 1`,
    )
  ).map((f) => ({ ...f, src: f.src.replaceAll("\r\n", "\n") }));
  return { columns, constraints, indexes, triggers, functions };
}

describe("migrations (MikroORM Migrator programático)", () => {
  test("round-trip up → down → up, com catálogo idêntico ao gabarito e down sem resíduo", async () => {
    const all = migrationsList.map((m) => m.name);
    expect(all.length).toBeGreaterThan(0);
    const expected = await catalog(reference.url);
    // o gabarito não pode estar vazio (senão a igualdade abaixo seria trivial)
    expect(expected.columns!.length).toBeGreaterThan(40);
    expect(expected.triggers!.filter((t) => t.tgdeferrable === true && t.tginitdeferred === true)).toHaveLength(2);
    expect(expected.functions).toHaveLength(5);

    const up1 = await migrateUp(orm);
    expect(up1.applied).toEqual(all);
    expect(await recorded()).toEqual(all);
    expect(await catalog(scratch.url)).toEqual(expected);

    const again = await migrateUp(orm);
    expect(again.applied).toEqual([]);

    const down = await migrateDown(orm, true);
    expect(down.applied).toEqual([...all].reverse());
    expect(await recorded()).toEqual([]);
    expect(await catalog(scratch.url)).toEqual({ columns: [], constraints: [], indexes: [], triggers: [], functions: [] });

    const up2 = await migrateUp(orm);
    expect(up2.applied).toEqual(all);
    expect(await recorded()).toEqual(all);
    expect(await catalog(scratch.url)).toEqual(expected);
  });
});
