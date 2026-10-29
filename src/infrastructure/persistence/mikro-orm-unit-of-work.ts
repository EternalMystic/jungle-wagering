import type { Knex } from "@mikro-orm/postgresql";
import { ApplicationError, TransientInfrastructureError } from "../../application/errors";
import type { TransactionalRepositories, UnitOfWork } from "../../application/ports/unit-of-work";
import type { Orm } from "./orm";
import { isLockConflict, isTransientDatabaseError } from "./pg-errors";
import { SqlSession } from "./sql-session";
import { sqlRepositories } from "./sql-repositories";
import { NO_METRICS, type Metrics } from "../../application/ports/metrics";

/**
 * Uma chamada = um `em.transactional` (BEGIN … COMMIT, READ COMMITTED: a decisão é tomada
 * sob o row lock da wallet, D3). `lock_timeout` local à transação: esperar o lock de uma
 * wallet quente além disso vira falha TRANSITÓRIA (503 / retry), nunca espera infinita.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: Orm,
    private readonly lockTimeoutMs: number,
    private readonly metrics: Metrics = NO_METRICS,
  ) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    const committed: (() => void)[] = [];
    const result = await this.withSql((sql) => {
      const r = sqlRepositories(sql);
      const insert = r.transactions.insert.bind(r.transactions);
      const save = r.transactions.savePending.bind(r.transactions);
      const inbox = r.inbox.insertIfAbsent.bind(r.inbox);
      r.transactions.insert = async (tx) => {
        await insert(tx);
        const { status, kind } = tx;
        committed.push(() => this.metrics.transaction(status, kind));
      };
      r.transactions.savePending = async (tx) => {
        await save(tx);
        if (tx.isTerminal()) {
          const { status, kind } = tx;
          committed.push(() => this.metrics.transaction(status, kind));
        }
      };
      r.inbox.insertIfAbsent = async (message) => {
        const previous = await inbox(message);
        if (previous !== undefined) committed.push(() => this.metrics.inboxDuplicate());
        return previous;
      };
      return work(r);
    });
    for (const observe of committed) observe();
    return result;
  }

  async withSql<T>(work: (sql: SqlSession) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const trx = em.getTransactionContext<Knex.Transaction>();
        if (trx === undefined) throw new Error("em.transactional did not open a transaction context");
        const sql = new SqlSession(trx);
        await sql.query("SELECT set_config('lock_timeout', ?, true)", [`${this.lockTimeoutMs}ms`]);
        return work(sql);
      });
    } catch (error) {
      if (isLockConflict(error)) this.metrics.lockConflict();
      if (error instanceof ApplicationError) throw error;
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError("database temporarily unavailable", { cause: error });
      }
      throw error;
    }
  }
}
