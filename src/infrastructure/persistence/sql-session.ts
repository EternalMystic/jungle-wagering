import type { Knex } from "@mikro-orm/postgresql";

export type SqlValue = string | number | boolean | Date | null;

export interface SqlResult<R> {
  readonly rows: R[];
  readonly rowCount: number;
}

/**
 * Executor preso à transação aberta por `em.transactional` (D1: trechos críticos em SQL
 * explícito DENTRO da mesma transação). Placeholders `?` viram parâmetros posicionais do
 * driver (`$1`, `$2`…) — nada é interpolado no texto do SQL.
 */
export class SqlSession {
  constructor(private readonly trx: Knex.Transaction) {}

  async query<R>(sql: string, bindings: readonly SqlValue[] = []): Promise<SqlResult<R>> {
    const res = (await this.trx.raw(sql, bindings as Knex.RawBinding[])) as { rows?: R[]; rowCount?: number | null };
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
  }
}
