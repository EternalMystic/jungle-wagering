import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  // Copia o contexto antes: mutar o pai mistura logs de tarefas paralelas.
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

export function logContext(): LogContext { return storage.getStore() ?? {}; }

export function enrichLogContext(context: LogContext): void {
  const current = storage.getStore();
  if (current !== undefined) Object.assign(current, context);
}
