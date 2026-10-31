#!/usr/bin/env bun
// Direto pelo Bun: o CLI do MikroORM depende de ts-node e descoberta de config.
// down reverte a ultima migration; down --all reverte todas.
import { loadConfig } from "../src/infrastructure/config/app-config";
import { initOrm, migrateDown, migrateUp } from "../src/infrastructure/persistence/orm";

const [cmd, flag] = process.argv.slice(2);
if (cmd !== "up" && cmd !== "down") {
  console.error("uso: bun run scripts/migrate.ts <up|down> [--all]");
  process.exit(2);
}

const orm = await initOrm(loadConfig());
try {
  let res: Awaited<ReturnType<typeof migrateUp>>;
  if (cmd === "up") {
    res = await migrateUp(orm);
  } else {
    res = await migrateDown(orm, flag === "--all");
  }
  const verb = cmd === "up" ? "aplicadas" : "revertidas";
  console.log(`migrations ${verb}: ${res.applied.length ? res.applied.join(", ") : "(nenhuma)"}`);
  console.log(`executadas agora: ${res.executed.length ? res.executed.join(", ") : "(nenhuma)"}`);
} catch (err) {
  console.error("migration falhou:", err);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
