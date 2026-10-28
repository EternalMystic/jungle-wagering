import { MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../config/app-config";
import { mikroOrmConfig } from "./mikro-orm.config";

export type Orm = MikroORM;

export function initOrm(config: AppConfig): Promise<Orm> {
  return MikroORM.init(mikroOrmConfig(config));
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly executed: readonly string[];
}

async function executedNames(orm: Orm): Promise<string[]> {
  const executed = await orm.getMigrator().getExecutedMigrations();
  return executed.map((m) => m.name);
}

/** Aplica todas as migrations pendentes. */
export async function migrateUp(orm: Orm): Promise<MigrationRunResult> {
  const applied = await orm.getMigrator().up();
  return { applied: applied.map((m) => m.name), executed: await executedNames(orm) };
}

/** Reverte a última migration aplicada (ou todas, com `all`). */
export async function migrateDown(orm: Orm, all = false): Promise<MigrationRunResult> {
  const migrator = orm.getMigrator();
  const reverted = all ? await migrator.down({ to: 0 }) : await migrator.down();
  return { applied: reverted.map((m) => m.name), executed: await executedNames(orm) };
}
