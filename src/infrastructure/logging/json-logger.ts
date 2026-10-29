import { ApplicationError } from "../../application/errors";
import { DomainError } from "../../domain/errors";

/**
 * Log estruturado mínimo (uma linha JSON por evento) até o pino entrar (D12 / PLANO S9).
 * Campos de contexto: `correlationId, messageId, transactionId, walletId, providerId` —
 * nunca o payload financeiro completo.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
  constructor(private readonly component: string) {}

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  private write(level: string, msg: string, fields: LogFields | undefined): void {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, component: this.component, msg, ...fields })}\n`);
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof DomainError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && code.length === 5 && /^[0-9A-Z]{5}$/.test(code)) return `DATABASE_ERROR:${code}`;
  }
  return "UNEXPECTED_ERROR";
}
