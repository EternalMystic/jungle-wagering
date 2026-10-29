/** Erro do driver `pg` (fronteira de I/O: campos opcionais e não tipados). */
interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly name?: unknown;
}

function shape(error: unknown): PgErrorShape {
  return typeof error === "object" && error !== null ? (error as PgErrorShape) : {};
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = shape(error);
  return e.code === "23505" && e.constraint === constraint;
}

/**
 * SQLSTATEs que justificam reenviar a mesma requisição (D5 → 503): lock_timeout,
 * serialização/deadlock, banco reiniciando, conexão; e falhas de rede/pool do cliente.
 */
const TRANSIENT_SQLSTATES = new Set(["55P03", "40001", "40P01", "57P01", "57P02", "57P03", "53300"]);
const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

export function isTransientDatabaseError(error: unknown): boolean {
  const e = shape(error);
  if (typeof e.code === "string") {
    if (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code)) return true;
    if (e.code.startsWith("08")) return true; // connection_exception
  }
  // knex: "Timeout acquiring a connection. The pool is probably full."
  if (e.name === "KnexTimeoutError") return true;
  return error instanceof Error && /Connection terminated|connection.*(closed|lost)/i.test(error.message);
}
