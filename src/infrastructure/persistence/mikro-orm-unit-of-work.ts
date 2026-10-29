import type { Knex } from "@mikro-orm/postgresql";
import { ApplicationError, TransientInfrastructureError } from "../../application/errors";
import type { TransactionalRepositories, UnitOfWork } from "../../application/ports/unit-of-work";
import type { Orm } from "./orm";
import { isTransientDatabaseError } from "./pg-errors";
import { SqlSession } from "./sql-session";
import { sqlRepositories } from "./sql-repositories";

/**
 * Uma chamada = um `em.transactional` (BEGIN … COMMIT, READ COMMITTED: a decisão é tomada
 * sob o row lock da wallet, D3). `lock_timeout` local à transação: esperar o lock de uma
 * wallet quente além disso vira falha TRANSITÓRIA (503 / retry), nunca espera infinita.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: Orm,
    private readonly lockTimeoutMs: number,
  ) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const trx = em.getTransactionContext<Knex.Transaction>();
        if (trx === undefined) throw new Error("em.transactional did not open a transaction context");
        const sql = new SqlSession(trx);
        await sql.query("SELECT set_config('lock_timeout', ?, true)", [`${this.lockTimeoutMs}ms`]);
        return work(sqlRepositories(sql));
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError("database temporarily unavailable", { cause: error });
      }
      throw error;
    }
  }
}
