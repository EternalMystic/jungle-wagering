/**
 * Harness MULTI-PROCESSO: N instâncias reais da aplicação (`bun run src/main.ts` via
 * `Bun.spawn`), cada uma na sua porta, todas no MESMO banco e nas MESMAS filas SQS.
 * Nada de "instâncias" no mesmo processo: cada uma tem o seu pool, o seu consumer,
 * o seu publisher e morre de verdade (SIGKILL = nenhum cleanup roda).
 *
 * - `Cluster.start` cria as filas uma vez e sobe as instâncias em paralelo, esperando
 *   `/health/ready` = 200 em cada uma.
 * - `kill(i)` = SIGKILL; `stop(i)` = SIGTERM (drain); `restart(i, env)` sobe uma instância
 *   NOVA (outro pid, outra porta) no lugar da i-ésima — estado só pode vir do banco.
 * - `FAULT_POINT` por instância (`env`) arma o FaultInjector (D20): a instância se mata
 *   sozinha no checkpoint; `waitForExit` espera isso acontecer, com prazo.
 */
import { DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type QueueNames, loadConfig } from "../../src/infrastructure/config/app-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { type QueueTopology, setupQueues } from "../../src/infrastructure/sqs/setup-queues";
import { freePort, tail, uniqueQueueNames } from "./app-process";
import { REPO_ROOT } from "./database";
import { ApiClient } from "./http-client";

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/**
 * Pool por instância. 3 × 25 = 75 cabe no `max_connections = 100` do Postgres junto com o
 * pool do teste; e 25 > 50/3, então as 50 requisições do teste 1 cabem TODAS no banco ao
 * mesmo tempo. Excedente espera no pool do knex (fila local do processo, não lock global).
 */
export const INSTANCE_POOL_MAX = 25;

export type Env = Readonly<Record<string, string>>;

export interface Instance {
  /** nome estável do processo (vai em `INSTANCE_ID`); muda a cada restart */
  readonly name: string;
  readonly pid: number;
  readonly baseUrl: string;
  readonly api: ApiClient;
  readonly exited: Promise<number>;
  isAlive(): boolean;
  logs(): string;
}

interface ManagedInstance extends Instance {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly drained: Promise<unknown>;
}

export interface ClusterOptions {
  readonly databaseUrl: string;
  readonly tag: string;
  readonly instances: number;
  /** env comum a todas */
  readonly env?: Env;
  /** env específico por índice (ex.: `FAULT_POINT` só na instância 0) */
  readonly envFor?: (index: number) => Env | undefined;
}

export class Cluster {
  private readonly slots: ManagedInstance[] = [];
  private generation = 0;

  private constructor(
    private readonly options: ClusterOptions,
    readonly queueNames: QueueNames,
    readonly queues: QueueTopology,
    readonly sqs: SQSClient,
  ) {}

  static async start(options: ClusterOptions): Promise<Cluster> {
    if (options.instances < 1) throw new Error("cluster precisa de ≥ 1 instância");
    const sqs = createSqsClient(loadConfig().aws);
    const names = uniqueQueueNames(options.tag);
    const topology = await setupQueues(sqs, names);
    const cluster = new Cluster(options, names, topology, sqs);
    try {
      const started = await Promise.all(
        Array.from({ length: options.instances }, (_, i) => cluster.spawn(i, options.envFor?.(i))),
      );
      cluster.slots.push(...started);
    } catch (error) {
      await cluster.dispose();
      throw error;
    }
    return cluster;
  }

  get size(): number {
    return this.slots.length;
  }

  instance(index: number): Instance {
    const slot = this.slots[index];
    if (slot === undefined) throw new Error(`instância ${index} não existe (cluster de ${this.slots.length})`);
    return slot;
  }

  get instances(): readonly Instance[] {
    return this.slots;
  }

  /** Cliente da instância `i mod N` (distribui requisições entre processos). */
  api(index: number): ApiClient {
    return this.instance(index % this.slots.length).api;
  }

  /** SIGKILL: nada de shutdown hook, drain, ROLLBACK educado. */
  async kill(index: number): Promise<void> {
    const slot = this.managed(index);
    if (slot.isAlive()) slot.proc.kill("SIGKILL");
    await slot.exited;
    await slot.drained;
  }

  async killAll(): Promise<void> {
    await Promise.all(this.slots.map((_, i) => this.kill(i)));
  }

  /** SIGTERM e espera sair (o drain do consumer é responsabilidade da aplicação, D9). */
  async stop(index: number): Promise<void> {
    const slot = this.managed(index);
    if (slot.isAlive()) {
      slot.proc.kill("SIGTERM");
      const exited = await Promise.race([slot.exited.then(() => true), Bun.sleep(STOP_TIMEOUT_MS).then(() => false)]);
      if (!exited) slot.proc.kill("SIGKILL");
    }
    await slot.exited;
    await slot.drained;
  }

  /** Mata (se viva) e sobe um processo NOVO no lugar; `env` substitui o env específico da instância. */
  async restart(index: number, env?: Env): Promise<Instance> {
    this.managed(index);
    await this.kill(index);
    const fresh = await this.spawn(index, env);
    this.slots[index] = fresh;
    return fresh;
  }

  async restartAll(env?: Env): Promise<void> {
    await this.killAll();
    const fresh = await Promise.all(this.slots.map((_, i) => this.spawn(i, env)));
    fresh.forEach((instance, i) => {
      this.slots[i] = instance;
    });
  }

  /** Espera a instância morrer sozinha (FaultInjector). Falha com os logs se o prazo vencer. */
  async waitForExit(index: number, timeoutMs: number, reason: string): Promise<number> {
    const slot = this.managed(index);
    const code = await Promise.race([slot.exited, Bun.sleep(timeoutMs).then(() => undefined)]);
    if (code === undefined) {
      throw new Error(`instância ${slot.name} não morreu em ${timeoutMs} ms (${reason}). Logs:\n${slot.logs()}`);
    }
    await slot.drained;
    return code;
  }

  async sendWagerMessage(message: WagerQueueMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.wagerTransactions.url,
        MessageBody: JSON.stringify(message),
        MessageGroupId: message.data.walletId,
        MessageDeduplicationId: message.messageId,
      }),
    );
  }

  /** Mensagens visíveis + em voo (+ atrasadas) da fila. */
  async queueDepth(url: string): Promise<number> {
    const res = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );
    const a = res.Attributes ?? {};
    return (
      Number.parseInt(a.ApproximateNumberOfMessages ?? "0", 10) +
      Number.parseInt(a.ApproximateNumberOfMessagesNotVisible ?? "0", 10) +
      Number.parseInt(a.ApproximateNumberOfMessagesDelayed ?? "0", 10)
    );
  }

  logs(): string {
    return this.slots.map((s) => `===== ${s.name} (pid ${s.pid}) =====\n${s.logs()}`).join("\n");
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.slots.map((_, i) => this.stop(i)));
    await Promise.allSettled(
      [this.queues.wagerTransactions, this.queues.wagerTransactionsDlq, this.queues.walletEvents].map((q) =>
        this.sqs.send(new DeleteQueueCommand({ QueueUrl: q.url })),
      ),
    );
    this.sqs.destroy();
  }

  private managed(index: number): ManagedInstance {
    const slot = this.slots[index];
    if (slot === undefined) throw new Error(`instância ${index} não existe (cluster de ${this.slots.length})`);
    return slot;
  }

  private async spawn(index: number, env: Env | undefined): Promise<ManagedInstance> {
    const name = `${this.options.tag}-${index}-g${this.generation++}`;
    const port = await freePort();
    const lines: string[] = [];
    const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: this.options.databaseUrl,
        PORT: String(port),
        SQS_WAGER_QUEUE: this.queueNames.wagerTransactions,
        SQS_WAGER_DLQ: this.queueNames.wagerTransactionsDlq,
        SQS_WALLET_EVENTS_QUEUE: this.queueNames.walletEvents,
        DB_POOL_MAX: String(INSTANCE_POOL_MAX),
        INSTANCE_ID: name,
        ...this.options.env,
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const drained = Promise.all([tail(proc.stdout, lines), tail(proc.stderr, lines)]).catch(() => undefined);
    const baseUrl = `http://127.0.0.1:${port}`;
    const instance: ManagedInstance = {
      name,
      pid: proc.pid,
      baseUrl,
      api: new ApiClient(baseUrl),
      exited: proc.exited,
      isAlive: () => proc.exitCode === null && proc.signalCode === null,
      logs: () => lines.join("\n"),
      proc,
      drained,
    };

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (!instance.isAlive()) {
        await drained;
        throw new Error(`instância ${name} morreu antes de ficar pronta (exit ${proc.exitCode}):\n${instance.logs()}`);
      }
      try {
        const res = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
        if (res.status === 200) return instance;
      } catch {
        // ainda não está ouvindo
      }
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        await proc.exited;
        await drained;
        throw new Error(`instância ${name} não ficou pronta em ${READY_TIMEOUT_MS} ms:\n${instance.logs()}`);
      }
      await Bun.sleep(100);
    }
  }
}

/** Mensagem da fila de entrada no formato da §10. */
export interface WagerQueueMessage {
  readonly messageId: string;
  readonly type: "WagerTransactionRequested";
  readonly occurredAt: string;
  readonly data: {
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly idempotencyKey: string;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly gameId: string;
    readonly kind: string;
    readonly money: { readonly amount: string; readonly currency: string };
    readonly referenceExternalTransactionId?: string;
  };
}

/**
 * Espera um estado EVENTUAL do sistema (worker, publisher, redelivery) consultando-o de
 * novo até `timeoutMs`. Não é sleep para "fazer passar": o teste exige o estado; o prazo só
 * transforma "nunca acontece" em falha legível (com o último valor observado).
 */
export async function eventually<T>(
  what: string,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: não aconteceu em ${timeoutMs} ms; último valor observado: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(intervalMs);
  }
}
