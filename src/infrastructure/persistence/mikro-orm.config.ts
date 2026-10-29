import { Socket } from "node:net";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "../../../migrations";
import type { AppConfig } from "../config/app-config";

export const MIGRATIONS_TABLE = "mikro_orm_migrations";

/**
 * Socket do driver `pg` com prazo de inatividade (D21). Postgres congelado (rede parada,
 * `docker pause`) não responde nem fecha a conexão: sem isto a query, e o ROLLBACK que vem
 * depois dela, esperariam para sempre. Destruir o socket faz o driver falhar a query
 * ("Connection terminated"), o knex descartar a conexão (`__knex__disposed`) e o servidor
 * abortar a transação quando voltar — a conexão NUNCA é reutilizada com uma transação
 * meio-aberta. Conexão ociosa no pool também cai após o prazo; o pool recria.
 */
function deadlineSocket(timeoutMs: number): Socket {
  const socket = new Socket();
  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error(`postgres socket without traffic for ${timeoutMs} ms`));
  });
  return socket;
}

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
    pool: { min: 0, max: config.dbPoolMax, acquireTimeoutMillis: config.dbAcquireTimeoutMs },
    driverOptions: {
      connection: {
        connectionTimeoutMillis: config.dbConnectTimeoutMs,
        stream: () => deadlineSocket(config.dbSocketTimeoutMs),
      },
    },
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
