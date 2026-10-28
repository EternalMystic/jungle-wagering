/**
 * Configuração do processo, lida do ambiente uma única vez na borda.
 * Defaults apontam para o docker-compose.yml local (Postgres na 55432, emulador SQS na 4566).
 */
export interface QueueNames {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly walletEvents: string;
}

export interface AwsConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly aws: AwsConfig;
  readonly queues: QueueNames;
  readonly httpPort: number;
  readonly readinessTimeoutMs: number;
}

export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:55432/wagering";

type Env = Readonly<Record<string, string | undefined>>;

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

function nonEmpty(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function url(env: Env, key: string, fallback: string, protocols: readonly string[]): string {
  const value = nonEmpty(env, key, fallback);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidConfigError(`${key} não é uma URL válida`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new InvalidConfigError(`${key} deve usar ${protocols.join(" ou ")}`);
  }
  return value;
}

function positiveInt(env: Env, key: string, fallback: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new InvalidConfigError(`${key} deve ser inteiro positivo`);
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > max) throw new InvalidConfigError(`${key} fora do intervalo 1..${max}`);
  return value;
}

function fifoName(env: Env, key: string, fallback: string): string {
  const value = nonEmpty(env, key, fallback);
  if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(value)) {
    throw new InvalidConfigError(`${key} deve ser um nome de fila FIFO válido (terminar em .fifo)`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    databaseUrl: url(env, "DATABASE_URL", DEFAULT_DATABASE_URL, ["postgres:", "postgresql:"]),
    aws: {
      endpoint: url(env, "AWS_ENDPOINT_URL", "http://localhost:4566", ["http:", "https:"]),
      region: nonEmpty(env, "AWS_REGION", "us-east-1"),
      accessKeyId: nonEmpty(env, "AWS_ACCESS_KEY_ID", "test"),
      secretAccessKey: nonEmpty(env, "AWS_SECRET_ACCESS_KEY", "test"),
    },
    queues: {
      wagerTransactions: fifoName(env, "SQS_WAGER_QUEUE", "wager-transactions.fifo"),
      wagerTransactionsDlq: fifoName(env, "SQS_WAGER_DLQ", "wager-transactions-dlq.fifo"),
      walletEvents: fifoName(env, "SQS_WALLET_EVENTS_QUEUE", "wallet-events.fifo"),
    },
    httpPort: positiveInt(env, "PORT", 3000, 65535),
    readinessTimeoutMs: positiveInt(env, "READINESS_TIMEOUT_MS", 2000, 60000),
  };
}
