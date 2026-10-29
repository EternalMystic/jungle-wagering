import type { LoggerService } from "@nestjs/common";
import { JsonLogger, errorText } from "./json-logger";

/** Mensagens arbitrárias do framework podem carregar corpos/erros do driver. */
export class NestJsonLogger implements LoggerService {
  private readonly logger = new JsonLogger("nest");
  log(): void { this.logger.info("nest framework event"); }
  warn(): void { this.logger.warn("nest framework warning"); }
  error(error: unknown): void { this.logger.error("nest framework error", { error: errorText(error) }); }
}
