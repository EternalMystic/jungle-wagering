/**
 * Paralelismo REAL e PROVADO.
 *
 * - `StartBarrier`: nenhum participante dispara antes que todos tenham chegado.
 * - `contend`: o teste segura, numa conexão PRÓPRIA, o recurso que as requisições vão
 *   disputar (ex.: a linha da wallet `FOR UPDATE`), dispara as requisições e só solta
 *   quando o Postgres mostrar N backends DA APLICAÇÃO bloqueados em `Lock` ao mesmo
 *   tempo (pg_stat_activity, conexão autocommit separada para não ver snapshot velho).
 *   Isso prova que houve sobreposição de verdade dentro do banco — não basta "passar".
 *   O limite de espera é curto (abaixo do `lock_timeout` de D3) e não é sleep: o
 *   portão abre assim que a disputa é observada.
 */
import type { Pool, PoolClient } from "pg";

export class StartBarrier {
  private arrived = 0;
  private open!: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly parties: number) {
    if (parties < 1) throw new Error("barreira precisa de ≥ 1 participante");
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  /** Chega à barreira e espera os demais. */
  async arrive(): Promise<void> {
    this.arrived++;
    if (this.arrived === this.parties) this.open();
    if (this.arrived > this.parties) throw new Error("mais participantes que o previsto na barreira");
    await this.gate;
  }
}

/** Dispara `n` tarefas que só começam juntas, depois que todas chegaram à barreira. */
export function launchTogether<T>(n: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const barrier = new StartBarrier(n);
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
      await barrier.arrive();
      return task(i);
    }),
  );
}

/** Maior número de intervalos [início, fim] simultâneos (prova de sobreposição no cliente). */
export function maxInFlight(intervals: ReadonlyArray<{ startedAt: number; finishedAt: number }>): number {
  const events = intervals.flatMap((r) => [
    { t: r.startedAt, d: 1 },
    { t: r.finishedAt, d: -1 },
  ]);
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let max = 0;
  for (const e of events) {
    current += e.d;
    max = Math.max(max, current);
  }
  return max;
}

export interface ContentionReport<T> {
  readonly results: T;
  /** máximo de backends da aplicação vistos esperando lock simultaneamente */
  readonly maxWaiters: number;
}

export interface ContendOptions<T> {
  readonly pool: Pool;
  /** Toma, na conexão do teste e dentro de uma transação aberta, o recurso disputado. */
  readonly hold: (client: PoolClient) => Promise<void>;
  /** Dispara o trabalho concorrente (não deve esperar o portão). */
  readonly run: () => Promise<T>;
  /** Abre o portão assim que este número de backends estiver bloqueado. */
  readonly expectedWaiters: number;
  /** Prazo máximo segurando o recurso; abaixo do lock_timeout da aplicação. */
  readonly maxHoldMs?: number;
}

export async function countLockWaiters(pool: Pool, excludePid: number): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> $1
        AND pid <> pg_backend_pid()`,
    [excludePid],
  );
  return res.rows[0]?.n ?? 0;
}

export async function contend<T>(options: ContendOptions<T>): Promise<ContentionReport<T>> {
  const maxHoldMs = options.maxHoldMs ?? 3_000;
  const holder = await options.pool.connect();
  let maxWaiters = 0;
  try {
    const pidRow = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const holderPid = pidRow.rows[0]?.pid ?? -1;
    await holder.query("BEGIN");
    await options.hold(holder);

    let settled = false;
    const work = options.run().then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );

    const deadline = performance.now() + maxHoldMs;
    while (!settled && performance.now() < deadline) {
      const n = await countLockWaiters(options.pool, holderPid);
      maxWaiters = Math.max(maxWaiters, n);
      if (n >= options.expectedWaiters) break;
      await Bun.sleep(5);
    }
    await holder.query("ROLLBACK");

    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
    return { results: outcome.value, maxWaiters };
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}
