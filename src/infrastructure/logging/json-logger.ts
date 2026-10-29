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
        return [key, typeof v === "string" && /^(?:[A-Z][A-Z_]{0,127}|DATABASE_ERROR:[0-9A-Z]{5})$/.test(v) ? v : errorText(v)];
      }
      return [key, SENSITIVE.test(key) ? "[REDACTED]" : clean(v, depth + 1)];
    }));
  };
  return clean(fields, 0) as Record<string, unknown>;
}

export function errorText(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof DomainError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && code.length === 5 && /^[0-9A-Z]{5}$/.test(code)) return `DATABASE_ERROR:${code}`;
  }
  return "UNEXPECTED_ERROR";
}
