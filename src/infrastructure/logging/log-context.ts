import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, work);
}

export function logContext(): LogContext { return storage.getStore() ?? {}; }

export function enrichLogContext(context: LogContext): void {
  const current = storage.getStore();
  if (current !== undefined) Object.assign(current, context);
}
