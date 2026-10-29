/**
 * Sobe a aplicação como PROCESSO REAL (`bun run src/main.ts`) apontada para o banco
 * isolado do arquivo e para filas SQS exclusivas do arquivo (nada compartilhado com
 * outros testes nem com o ambiente de desenvolvimento). Espera `/health/ready` = 200.
 *
 * Contrato de ambiente com a aplicação (D16 em docs/DECISOES.md):
 *   DATABASE_URL, PORT, SQS_WAGER_QUEUE, SQS_WAGER_DLQ, SQS_WALLET_EVENTS_QUEUE,
 *   DB_POOL_MAX (pool do processo ≥ paralelismo dos testes).
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { type QueueNames, loadConfig } from "../../src/infrastructure/config/app-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { setupQueues } from "../../src/infrastructure/sqs/setup-queues";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { REPO_ROOT } from "./database";

/** Pool de conexões do processo da aplicação nos testes: > maior paralelismo (50). */
export const APP_POOL_MAX = 60;

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_TAIL_LINES = 200;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("porta livre não obtida"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

/** Consome um stream do processo (sem isso o pipe enche e o filho trava) guardando a cauda. */
export function tail(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  return (async () => {
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (lines.length > LOG_TAIL_LINES) lines.shift();
      }
    }
    if (pending) lines.push(pending);
  })();
}

export function uniqueQueueNames(tag: string): QueueNames {
  const id = `${tag.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  return {
    wagerTransactions: `acc-${id}-wager-transactions.fifo`,
    wagerTransactionsDlq: `acc-${id}-wager-transactions-dlq.fifo`,
    walletEvents: `acc-${id}-wallet-events.fifo`,
  };
}

export interface AppProcess {
  readonly baseUrl: string;
  readonly queues: QueueNames;
  readonly pid: number;
  logs(): string;
  stop(): Promise<void>;
}

export interface StartAppOptions {
  readonly databaseUrl: string;
  readonly tag: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export async function startApp(options: StartAppOptions): Promise<AppProcess> {
  const config = loadConfig();
  const queues = uniqueQueueNames(options.tag);
  const sqs = createSqsClient(config.aws);
  const topology = await setupQueues(sqs, queues);

  const port = await freePort();
  const lines: string[] = [];
  const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: options.databaseUrl,
      PORT: String(port),
      SQS_WAGER_QUEUE: queues.wagerTransactions,
      SQS_WAGER_DLQ: queues.wagerTransactionsDlq,
      SQS_WALLET_EVENTS_QUEUE: queues.walletEvents,
      DB_POOL_MAX: String(APP_POOL_MAX),
      ...options.extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const drained = Promise.all([tail(proc.stdout, lines), tail(proc.stderr, lines)]);
  const baseUrl = `http://127.0.0.1:${port}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    await drained.catch(() => undefined);
    await Promise.allSettled(
      [topology.wagerTransactions, topology.wagerTransactionsDlq, topology.walletEvents].map((q) =>
        sqs.send(new DeleteQueueCommand({ QueueUrl: q.url })),
      ),
    );
    sqs.destroy();
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null) {
      await stop();
      throw new Error(`a aplicação morreu antes de ficar pronta (exit ${proc.exitCode}):\n${lines.join("\n")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) break;
    } catch {
      // ainda não está ouvindo
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`a aplicação não ficou pronta em ${READY_TIMEOUT_MS} ms:\n${lines.join("\n")}`);
    }
    await Bun.sleep(100);
  }

  return { baseUrl, queues, pid: proc.pid, logs: () => lines.join("\n"), stop };
}
