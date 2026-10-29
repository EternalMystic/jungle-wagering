/** Erro do driver `pg` (fronteira de I/O: campos opcionais e não tipados). */
interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly name?: unknown;
}

function shape(error: unknown): PgErrorShape {
  return typeof error === "object" && error !== null ? (error as PgErrorShape) : {};
}

export function isLockConflict(error: unknown, depth = 0): boolean {
  const code = shape(error).code;
  if (code === "55P03" || code === "40001" || code === "40P01") return true;
  return error instanceof Error && error.cause !== undefined && depth < 3 && isLockConflict(error.cause, depth + 1);
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

/**
 * Mensagens do driver/pool para conexão perdida: socket destruído pelo prazo de inatividade
 * (D21), conexão encerrada, cliente já fechado, prazo de conexão nova. "Transaction query
 * already complete" é como o knex reporta a próxima query de uma transação cuja conexão caiu
 * no meio (a causa original se perde); a UoW nunca reusa uma transação encerrada.
 */
const TRANSIENT_MESSAGE =
  /Connection terminated|connection.*(closed|lost)|not queryable|postgres socket without traffic|timeout expired|Timeout acquiring a connection|Transaction query already complete/i;

export function isTransientDatabaseError(error: unknown, depth = 0): boolean {
  const e = shape(error);
  if (typeof e.code === "string") {
    if (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code)) return true;
    if (e.code.startsWith("08")) return true; // connection_exception
  }
  // knex: "Timeout acquiring a connection. The pool is probably full."
  if (e.name === "KnexTimeoutError") return true;
  if (error instanceof Error && TRANSIENT_MESSAGE.test(error.message)) return true;
  // MikroORM embrulha o erro do driver; a causa original decide
  return error instanceof Error && error.cause !== undefined && depth < 3 && isTransientDatabaseError(error.cause, depth + 1);
}
