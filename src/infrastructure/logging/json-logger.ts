import { ApplicationError } from "../../application/errors";
import { DomainError } from "../../domain/errors";
import pino from "pino";
import { logContext } from "./log-context";

/** D12: pino JSON, contexto assíncrono e redação defensiva na fronteira de logging. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
  private readonly logger;
  constructor(component: string) {
    this.logger = pino({
      base: { component },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (level) => ({ level }), log: (fields) => sanitize(fields) },
      redact: { paths: ["money", "payload", "body", "data", "authorization", "cookie", "*.money", "*.payload"], censor: "[REDACTED]" },
    }, { write: (line) => { process.stdout.write(line); } });
  }

  info(msg: string, fields?: LogFields): void {
    this.logger.info({ ...fields, ...logContext() }, msg);
  }

  warn(msg: string, fields?: LogFields): void {
    this.logger.warn({ ...fields, ...logContext() }, msg);
  }

  error(msg: string, fields?: LogFields): void {
    this.logger.error({ ...fields, ...logContext() }, msg);
  }
}

const SENSITIVE = /^(money|payload|body|data|amount|balance|balanceBefore|balanceAfter|storedBalance|calculatedBalance|difference|authorization|cookie|headers|password|secret|token|accessKeyId|secretAccessKey|message|stack|cause|detail)$/i;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown, depth: number): unknown => {
    if (value instanceof Error) return errorText(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 8) return "[REDACTED]";
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (/^(error|err)$/i.test(key)) {
        return [key, typeof v === "string" && ERROR_TEXT.test(v) ? v : errorText(v)];
      }
      return [key, SENSITIVE.test(key) ? "[REDACTED]" : clean(v, depth + 1)];
    }));
  };
  return clean(fields, 0) as Record<string, unknown>;
}

/** Formatos que `errorText` produz; qualquer outra string em `error` é tratada como suspeita. */
const ERROR_TEXT =
  /^(?:[A-Z][A-Z_]{0,127}|DATABASE_ERROR:[0-9A-Z]{5}|NETWORK_ERROR:E[A-Z]{2,30}|UNEXPECTED_ERROR:[A-Z][A-Za-z]{2,63})$/;

/**
 * Diagnóstico sem conteúdo: só identificadores que não carregam dados da requisição.
 * SQLSTATE do Postgres, código de sistema do Node (ECONNREFUSED…) e nome da classe do erro
 * (TimeoutError, QueueDoesNotExist…) bastam para separar banco fora, SQS fora e bug.
 * `message`, `stack`, `cause` e `detail` nunca entram: podem conter o payload financeiro.
 */
export function errorText(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof DomainError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `DATABASE_ERROR:${code}`;
    if (typeof code === "string" && /^E[A-Z]{2,30}$/.test(code)) return `NETWORK_ERROR:${code}`;
  }
  if (error instanceof Error && error.name !== "Error" && /^[A-Z][A-Za-z]{2,63}$/.test(error.name)) {
    return `UNEXPECTED_ERROR:${error.name}`;
  }
  return "UNEXPECTED_ERROR";
}
