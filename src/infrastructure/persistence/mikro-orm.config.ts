import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "../../../migrations";
import type { AppConfig } from "../config/app-config";

export const MIGRATIONS_TABLE = "mikro_orm_migrations";

/**
 * Configuração do MikroORM montada a partir do AppConfig (sem arquivo de config
 * descoberto em runtime: o CLI do MikroORM não é usado; ver scripts/migrate.ts).
 */
export function mikroOrmConfig(config: AppConfig) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    debug: false,
    migrations: {
      tableName: MIGRATIONS_TABLE,
      migrationsList,
      transactional: true,
      allOrNothing: true,
      // true faria `session_replication_role = replica`, que DESLIGA os triggers do schema
      disableForeignKeys: false,
      snapshot: false,
      emit: "ts",
    },
  });
}
