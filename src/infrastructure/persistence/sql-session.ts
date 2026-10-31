import type { Knex } from "@mikro-orm/postgresql";

export type SqlValue = string | number | boolean | Date | null;

export interface SqlResult<R> {
  readonly rows: R[];
  readonly rowCount: number;
}

export class SqlSession {
  constructor(private readonly trx: Knex.Transaction) {}

  async query<R>(sql: string, args: readonly SqlValue[] = []): Promise<SqlResult<R>> {
    // O cast fica aqui no driver; não espalhar isso pelo domínio.
    const res = (await this.trx.raw(sql, args as Knex.RawBinding[])) as { rows?: R[]; rowCount?: number | null };
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
  }
}
