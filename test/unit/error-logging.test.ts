import { expect, spyOn, test } from "bun:test";
import type { ArgumentsHost } from "@nestjs/common";
import { TransientInfrastructureError } from "../../src/application/errors";
import { errorText } from "../../src/infrastructure/logging/json-logger";
import { ApiExceptionFilter } from "../../src/interface/http/http-problem";

const sensitive = JSON.stringify({ money: { amount: "987654321.23", currency: "BRL" }, walletId: "private-wallet" });

test("diagnóstico de erro permite códigos estáveis, sem message, stack, cause ou coerção de objetos", () => {
  const databaseError = Object.assign(new Error(`INSERT outbox ${sensitive}`), { code: "23514", detail: sensitive });
  expect(errorText(databaseError)).toBe("DATABASE_ERROR:23514");
  expect(errorText(new TransientInfrastructureError(sensitive, { cause: databaseError }))).toBe("TEMPORARILY_UNAVAILABLE");
  for (const error of [new Error(sensitive), sensitive, { toString: () => sensitive }, { code: sensitive }]) {
    expect(errorText(error)).toBe("UNEXPECTED_ERROR");
  }
});

test("filtro HTTP registra erro inesperado como JSON sem o payload financeiro e mantém resposta 500", () => {
  const lines: string[] = [];
  let status: number | undefined;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  const writeError = spyOn(process.stderr, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  try { new ApiExceptionFilter().catch(new Error(sensitive), host); }
  finally { write.mockRestore(); writeError.mockRestore(); }
  expect(status).toBe(500);
  expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: "unexpected error", retryable: true } });
  expect(lines.join("")).not.toContain("987654321.23");
  expect(lines.join("")).not.toContain("private-wallet");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ component: "http", level: "error", error: "UNEXPECTED_ERROR" });
});
