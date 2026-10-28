import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "./infrastructure/config/app-config";
import { PostgresReadinessProbe, SqsReadinessProbe } from "./infrastructure/health/readiness-probes";
import type { Orm } from "./infrastructure/persistence/orm";
import { initOrm } from "./infrastructure/persistence/orm";
import { createSqsClient } from "./infrastructure/sqs/sqs-client";
import { HealthController } from "./interface/http/health/health.controller";
import { READINESS_PROBES, READINESS_TIMEOUT_MS } from "./interface/http/health/tokens";

export const APP_CONFIG = Symbol("APP_CONFIG");
export const ORM = Symbol("ORM");
export const SQS_CLIENT = Symbol("SQS_CLIENT");

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

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
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
        InfrastructureLifecycle,
      ],
    };
  }
}
