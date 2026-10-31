import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module";
import type { AppConfig } from "../../infrastructure/config/app-config";
import { ApiExceptionFilter } from "./http-problem";
import type { Request, Response, NextFunction } from "express";
import { JsonLogger } from "../../infrastructure/logging/json-logger";
import { withLogContext } from "../../infrastructure/logging/log-context";
import { correlationIdFrom } from "./wagering/dto";
import { NestJsonLogger } from "../../infrastructure/logging/nest-logger";

export interface CreateAppOptions {
  readonly logger?: boolean;
}

export async function createApp(cfg: AppConfig, opts: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(cfg), {
    logger: opts.logger === false ? false : new NestJsonLogger(),
    abortOnError: false,
  });
  const logger = new JsonLogger("http");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = correlationIdFrom(req.headers["x-correlation-id"], randomUUID);
    req.headers["x-correlation-id"] = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);
    withLogContext({ correlationId }, () => {
      res.once("finish", () => logger.info("http request completed", { statusCode: res.statusCode }));
      next();
    });
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
