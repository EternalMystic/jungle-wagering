import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from "../../application/errors";

/** Erro já classificado pela borda HTTP (validação de DTO, 404). */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HttpProblem";
  }
}

export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

/** Resposta Express mínima (evita depender dos tipos do express). */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Segundos sugeridos no `Retry-After` de falhas transitórias. */
export const RETRY_AFTER_SECONDS = 1;

interface Mapped {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: number;
}

const problem = (status: number, code: string, message: string, retryable: boolean): Mapped => ({
  status,
  body: { error: { code, message, retryable } } satisfies ErrorBody,
});

/**
 * Mapeamento D5, igual em todos os endpoints: cada situação tem UM status e UM `error.code`,
 * e `retryable` diz ao provedor se pode reenviar com a mesma key.
 */
export function mapError(exception: unknown): Mapped {
  if (exception instanceof HttpProblem) {
    return problem(exception.status, exception.code, exception.message, exception.retryable);
  }
  if (exception instanceof InvalidCommandError) return problem(400, "INVALID_PAYLOAD", exception.message, false);
  if (exception instanceof IdempotencyConflictError) return problem(409, "IDEMPOTENCY_CONFLICT", exception.message, false);
  if (exception instanceof WalletAlreadyExistsError) return problem(409, "WALLET_ALREADY_EXISTS", exception.message, false);
  if (exception instanceof TransientInfrastructureError) {
    return { ...problem(503, "TEMPORARILY_UNAVAILABLE", exception.message, true), retryAfter: RETRY_AFTER_SECONDS };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // corpo JSON inválido (body-parser) e rota inexistente também seguem o formato D5
    if (status === HttpStatus.BAD_REQUEST) return problem(400, "INVALID_PAYLOAD", exception.message, false);
    if (status === HttpStatus.NOT_FOUND) return problem(404, "NOT_FOUND", exception.message, false);
    const response = exception.getResponse();
    return { status, body: typeof response === "object" ? response : { statusCode: status, message: response } };
  }
  return problem(500, "INTERNAL_ERROR", "unexpected error", true);
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const mapped = mapError(exception);
    if (mapped.status >= 500 && mapped.status !== 503) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    }
    const res = host.switchToHttp().getResponse<HttpResponse>();
    if (mapped.retryAfter !== undefined) res.setHeader("Retry-After", String(mapped.retryAfter));
    res.status(mapped.status).json(mapped.body);
  }
}
