import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module";
import type { AppConfig } from "../../infrastructure/config/app-config";

export interface CreateAppOptions {
  readonly logger?: boolean;
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: options.logger === false ? false : undefined,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  return app;
}
