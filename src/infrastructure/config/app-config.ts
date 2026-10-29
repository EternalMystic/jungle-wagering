import { type FaultPoint, isFaultPoint } from "../../application/ports/fault-injector";

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
  /** Conexões do pool do processo (D16: ≥ requisições simultâneas que devem esperar NO banco). */
  readonly dbPoolMax: number;
  /** `lock_timeout` de cada transação (D3); > 3 s exigido pelos testes de disputa (D16). */
  readonly lockTimeoutMs: number;
  /** Prazo para abrir uma conexão nova com o Postgres. */
  readonly dbConnectTimeoutMs: number;
  /** Prazo para obter conexão do pool (pool cheio ou banco inalcançável → transitório). */
  readonly dbAcquireTimeoutMs: number;
  /**
   * Socket do Postgres sem tráfego por mais que isto é destruído (D21): banco congelado não
   * pode segurar uma transação aberta para sempre. Tem de ser > `lockTimeoutMs`.
   */
  readonly dbSocketTimeoutMs: number;
  readonly consumer: ConsumerConfig;
  readonly nodeEnv: string | undefined;
  /** `FAULT_POINT` (D20): só tem efeito com `NODE_ENV=test`; nome desconhecido é erro de config. */
  readonly faultPoint: FaultPoint | undefined;
}

/** Consumer da fila de entrada (D9). */
export interface ConsumerConfig {
  readonly enabled: boolean;
  /** Long polling do ReceiveMessage. */
  readonly waitTimeSeconds: number;
  /** Mensagens por ReceiveMessage (1..10). */
  readonly maxMessages: number;
  /** Visibilidade renovada (heartbeat) enquanto a mensagem é processada. */
  readonly visibilityTimeoutSeconds: number;
  /** Backoff de transitórios: `min(base · 2^(n−1), max)` com n = ApproximateReceiveCount. */
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  /** SIGTERM: prazo para concluir as mensagens em andamento antes de devolvê-las. */
  readonly shutdownGraceMs: number;
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

function faultPoint(env: Env): FaultPoint | undefined {
  const raw = env.FAULT_POINT?.trim();
  if (!raw) return undefined;
  if (!isFaultPoint(raw)) throw new InvalidConfigError(`FAULT_POINT desconhecido: ${raw}`);
  return raw;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new InvalidConfigError(`${key} deve ser true/false`);
}

function consumerConfig(env: Env): ConsumerConfig {
  const retryBaseSeconds = positiveInt(env, "SQS_RETRY_BASE_SECONDS", 2, 3600);
  const retryMaxSeconds = positiveInt(env, "SQS_RETRY_MAX_SECONDS", 60, 43_200);
  if (retryMaxSeconds < retryBaseSeconds) {
    throw new InvalidConfigError("SQS_RETRY_MAX_SECONDS deve ser ≥ SQS_RETRY_BASE_SECONDS");
  }
  return {
    enabled: bool(env, "SQS_CONSUMER_ENABLED", true),
    waitTimeSeconds: positiveInt(env, "SQS_WAIT_TIME_SECONDS", 20, 20),
    maxMessages: positiveInt(env, "SQS_MAX_MESSAGES", 10, 10),
    visibilityTimeoutSeconds: positiveInt(env, "SQS_VISIBILITY_TIMEOUT_SECONDS", 30, 43_200),
    retryBaseSeconds,
    retryMaxSeconds,
    shutdownGraceMs: positiveInt(env, "SQS_SHUTDOWN_GRACE_MS", 8000, 600_000),
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const lockTimeoutMs = positiveInt(env, "LOCK_TIMEOUT_MS", 5000, 600000);
  const dbSocketTimeoutMs = positiveInt(env, "DB_SOCKET_TIMEOUT_MS", 15_000, 600_000);
  if (dbSocketTimeoutMs <= lockTimeoutMs) {
    throw new InvalidConfigError("DB_SOCKET_TIMEOUT_MS deve ser > LOCK_TIMEOUT_MS (esperar um lock não é banco congelado)");
  }
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
    dbPoolMax: positiveInt(env, "DB_POOL_MAX", 20, 1000),
    lockTimeoutMs,
    dbConnectTimeoutMs: positiveInt(env, "DB_CONNECT_TIMEOUT_MS", 5000, 600_000),
    dbAcquireTimeoutMs: positiveInt(env, "DB_ACQUIRE_TIMEOUT_MS", 10_000, 600_000),
    dbSocketTimeoutMs,
    consumer: consumerConfig(env),
    nodeEnv: env.NODE_ENV?.trim() || undefined,
    faultPoint: faultPoint(env),
  };
}
