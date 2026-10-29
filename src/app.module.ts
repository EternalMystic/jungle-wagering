import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { OpenWallet } from "./application/open-wallet";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { SqlWalletReads } from "./infrastructure/persistence/sql-wallet-reads";
import { METRICS, PrometheusMetrics } from "./infrastructure/metrics/prometheus-metrics";
import { ObservedWagerProcessor } from "./infrastructure/observed-wager-processor";
import { NoopProviderIdentity } from "./infrastructure/noop-provider-identity";
import { AuthGuard, PROVIDER_IDENTITY } from "./interface/http/auth.guard";
import { WALLET_READS, RECONCILE_WALLET, WalletQueriesController } from "./interface/http/wallet-queries.controller";
import type { FaultInjector } from "./application/ports/fault-injector";
import type { UnitOfWork } from "./application/ports/unit-of-work";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { ResolvePendingReferences } from "./application/resolve-pending-references";
import { WageringQueries } from "./application/wagering-queries";
import type { AppConfig } from "./infrastructure/config/app-config";
import { PostgresReadinessProbe, SqsReadinessProbe } from "./infrastructure/health/readiness-probes";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { SqlBackgroundStore } from "./infrastructure/persistence/sql-background-store";
import { BackgroundWorkers } from "./infrastructure/workers/background-workers";
import { OUTBOX_METRICS, OutboxMetricsController } from "./interface/http/outbox-metrics.controller";
import type { Orm } from "./infrastructure/persistence/orm";
import { initOrm } from "./infrastructure/persistence/orm";
import { createFaultInjector } from "./infrastructure/faults/process-kill-fault-injector";
import { JsonLogger } from "./infrastructure/logging/json-logger";
import { createSqsClient } from "./infrastructure/sqs/sqs-client";
import { SystemClock, UuidV7Generator } from "./infrastructure/system";
import { HealthController } from "./interface/http/health/health.controller";
import { READINESS_PROBES, READINESS_TIMEOUT_MS } from "./interface/http/health/tokens";
import {
  FAULT_INJECTOR,
  ID_GENERATOR,
  OPEN_WALLET,
  PROCESS_WAGER_TRANSACTION,
  WAGERING_QUERIES,
} from "./interface/http/wagering/tokens";
import { WageringController } from "./interface/http/wagering/wagering.controller";
import { WalletsController } from "./interface/http/wagering/wallets.controller";
import { WagerQueueConsumer } from "./interface/sqs/wager-consumer";

export const APP_CONFIG = Symbol("APP_CONFIG");
export const ORM = Symbol("ORM");
export const SQS_CLIENT = Symbol("SQS_CLIENT");
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const CLOCK = Symbol("CLOCK");
export const WAGER_CONSUMER = Symbol("WAGER_CONSUMER");
export const BACKGROUND_WORKERS = Symbol("BACKGROUND_WORKERS");

// Tipos estruturais locais: o metadata do decorator vira `Object`, sem referenciar
// classes importadas só como tipo (o transpiler do Bun não as tem em runtime).
interface ClosableOrm {
  close(force?: boolean): Promise<void>;
}
interface DestroyableClient {
  destroy(): void;
}

/** Fecha pool do Postgres e cliente SQS no shutdown (app.close() / SIGTERM). */
@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: ClosableOrm,
    @Inject(SQS_CLIENT) private readonly sqs: DestroyableClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

interface StartStop {
  start(): void;
  stop(): Promise<void>;
}
interface ConsumerSwitch {
  readonly consumer: { readonly enabled: boolean };
}

/**
 * Consumer SQS (D9): começa a buscar no bootstrap; no SIGTERM (`enableShutdownHooks`) faz o
 * drain ANTES de `InfrastructureLifecycle` fechar o pool (beforeApplicationShutdown roda antes
 * de onApplicationShutdown).
 */
@Injectable()
class WagerConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: ConsumerSwitch,
    @Inject(WAGER_CONSUMER) private readonly consumer: StartStop,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}

@Injectable()
class BackgroundLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(BACKGROUND_WORKERS) private readonly workers: StartStop) {}
  onApplicationBootstrap(): void { this.workers.start(); }
  async beforeApplicationShutdown(): Promise<void> { await this.workers.stop(); }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WageringController, WalletQueriesController, OutboxMetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: METRICS, useFactory: () => new PrometheusMetrics() },
        { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
        AuthGuard,
        { provide: ORM, useFactory: () => initOrm(config) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.aws) },
        { provide: READINESS_TIMEOUT_MS, useValue: config.readinessTimeoutMs },
        {
          provide: READINESS_PROBES,
          inject: [ORM, SQS_CLIENT],
          useFactory: (orm: Orm, sqs: SQSClient) => [
            new PostgresReadinessProbe(orm),
            new SqsReadinessProbe(sqs, config.queues.wagerTransactions),
          ],
        },
        { provide: UNIT_OF_WORK, inject: [ORM, METRICS], useFactory: (orm: Orm, metrics: PrometheusMetrics) => new MikroOrmUnitOfWork(orm, config.lockTimeoutMs, metrics) },
        { provide: WALLET_READS, inject: [UNIT_OF_WORK], useFactory: (uow: MikroOrmUnitOfWork) => new SqlWalletReads(uow) },
        { provide: RECONCILE_WALLET, inject: [WALLET_READS, METRICS], useFactory: (reads: SqlWalletReads, metrics: PrometheusMetrics) => {
          const logger = new JsonLogger("reconciliation");
          return new ReconcileWallet(reads, metrics, { divergence: (walletId) => logger.error("wallet reconciliation divergence", { walletId }) });
        } },
        { provide: OUTBOX_METRICS, inject: [UNIT_OF_WORK], useFactory: (uow: MikroOrmUnitOfWork) => new SqlBackgroundStore(uow) },
        { provide: CLOCK, useValue: new SystemClock() },
        { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
        { provide: FAULT_INJECTOR, useValue: createFaultInjector(config.nodeEnv, config.faultPoint) },
        {
          provide: OPEN_WALLET,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (uow: UnitOfWork, clock: SystemClock, ids: UuidV7Generator) => new OpenWallet(uow, clock, ids),
        },
        {
          provide: PROCESS_WAGER_TRANSACTION,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, FAULT_INJECTOR, METRICS],
          useFactory: (uow: UnitOfWork, clock: SystemClock, ids: UuidV7Generator, faults: FaultInjector, metrics: PrometheusMetrics) =>
            new ObservedWagerProcessor(new ProcessWagerTransaction(uow, clock, ids, faults), metrics),
        },
        { provide: WAGERING_QUERIES, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WageringQueries(uow) },
        {
          provide: WAGER_CONSUMER,
          inject: [SQS_CLIENT, PROCESS_WAGER_TRANSACTION, FAULT_INJECTOR, ID_GENERATOR, METRICS],
          useFactory: (sqs: SQSClient, processWager: ObservedWagerProcessor, faults: FaultInjector, ids: UuidV7Generator, metrics: PrometheusMetrics) =>
            new WagerQueueConsumer({
              sqs,
              queues: config.queues,
              config: config.consumer,
              processWager,
              metrics,
              faults,
              logger: new JsonLogger("sqs-consumer"),
              generateId: () => ids.next(),
            }),
        },
        {
          provide: BACKGROUND_WORKERS,
          inject: [OUTBOX_METRICS, UNIT_OF_WORK, CLOCK, ID_GENERATOR, SQS_CLIENT, FAULT_INJECTOR],
          useFactory: (store: SqlBackgroundStore, uow: UnitOfWork, clock: SystemClock, ids: UuidV7Generator, sqs: SQSClient, faults: FaultInjector) =>
            new BackgroundWorkers(store, new ResolvePendingReferences(uow, clock, ids), sqs,
              config.queues.walletEvents, config.instanceId, faults, new JsonLogger("background-workers")),
        },
        InfrastructureLifecycle,
        WagerConsumerLifecycle,
        BackgroundLifecycle,
      ],
    };
  }
}
