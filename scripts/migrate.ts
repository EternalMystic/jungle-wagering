#!/usr/bin/env bun
/**
 * Migrator do MikroORM rodado programaticamente (o CLI `mikro-orm` depende de
 * ts-node/descoberta de config, frágil sob Bun).
 *
 *   bun run scripts/migrate.ts up
 *   bun run scripts/migrate.ts down          # reverte a última
 *   bun run scripts/migrate.ts down --all    # reverte todas
 */
import { loadConfig } from "../src/infrastructure/config/app-config";
import { initOrm, migrateDown, migrateUp } from "../src/infrastructure/persistence/orm";

const [command, flag] = process.argv.slice(2);
if (command !== "up" && command !== "down") {
  console.error("uso: bun run scripts/migrate.ts <up|down> [--all]");
  process.exit(2);
}

const orm = await initOrm(loadConfig());
try {
  const result = command === "up" ? await migrateUp(orm) : await migrateDown(orm, flag === "--all");
  const verb = command === "up" ? "aplicadas" : "revertidas";
  console.log(`migrations ${verb}: ${result.applied.length ? result.applied.join(", ") : "(nenhuma)"}`);
  console.log(`executadas agora: ${result.executed.length ? result.executed.join(", ") : "(nenhuma)"}`);
} catch (error) {
  console.error("migration falhou:", error);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
