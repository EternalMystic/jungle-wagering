import { expect, spyOn, test } from "bun:test";
import { JsonLogger } from "../../src/infrastructure/logging/json-logger";
import { enrichLogContext, logContext, withLogContext } from "../../src/infrastructure/logging/log-context";
import { AuthGuard } from "../../src/interface/http/auth.guard";
import type { ExecutionContext } from "@nestjs/common";

test("logger pino remove dinheiro, payload e credenciais inclusive em objetos aninhados", () => {
  const lines: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  try {
    new JsonLogger("redaction-test").info("safe message", {
      walletId: "wallet-safe", money: "FINANCIAL_SENTINEL", payload: "PAYLOAD_SENTINEL",
      authorization: "AUTH_SENTINEL",
      nested: { deeper: [{ money: "NESTED_SENTINEL", error: new Error("ERROR_SENTINEL"), payload: "DEEP_SENTINEL",
        err: { message: "RAW_ERROR_SENTINEL", detail: "RAW_DETAIL_SENTINEL" } }] },
    });
  } finally { write.mockRestore(); }
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("FINANCIAL_SENTINEL");
  expect(lines[0]).not.toContain("PAYLOAD_SENTINEL");
  expect(lines[0]).not.toContain("AUTH_SENTINEL");
  expect(lines[0]).not.toContain("NESTED_SENTINEL");
  expect(lines[0]).not.toContain("ERROR_SENTINEL");
  expect(lines[0]).not.toContain("DEEP_SENTINEL");
  expect(lines[0]).not.toContain("RAW_ERROR_SENTINEL");
  expect(lines[0]).not.toContain("RAW_DETAIL_SENTINEL");
  expect(JSON.parse(lines[0]!)).toMatchObject({ component: "redaction-test", level: "info", walletId: "wallet-safe" });
});

test("AsyncLocalStorage isola operações sobrepostas e restaura o contexto pai", async () => {
  const lines: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const logger = new JsonLogger("context-test");
  try {
    const first = withLogContext({ correlationId: "a", walletId: "wallet-a", messageId: "message-a", providerId: "provider-a" }, async () => {
      await barrier;
      enrichLogContext({ transactionId: "tx-a" });
      logger.info("first");
    });
    await withLogContext({ correlationId: "b", walletId: "wallet-b" }, async () => {
      release();
      await first;
      logger.info("second");
      withLogContext({ transactionId: "nested" }, () => logger.info("child"));
      expect(logContext().transactionId).toBeUndefined();
    });
    expect(logContext()).toEqual({});
  } finally { write.mockRestore(); }
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ correlationId: "a", walletId: "wallet-a", messageId: "message-a", providerId: "provider-a", transactionId: "tx-a" }),
    expect.objectContaining({ correlationId: "b", walletId: "wallet-b" }),
    expect.objectContaining({ correlationId: "b", walletId: "wallet-b", transactionId: "nested" }),
  ]);
  expect(JSON.parse(lines[1]!).messageId).toBeUndefined();
});

test("AuthGuard delega à porta de identidade: no-op libera; identidade divergente é recusada", async () => {
  let received: string | undefined;
  const context = { switchToHttp: () => ({ getRequest: () => ({ params: {}, body: { providerId: "provider-a" }, get: () => "Bearer test" }) }) } as unknown as ExecutionContext;
  const noop = new AuthGuard({ authenticate: async (authorization) => { received = authorization; return undefined; } });
  expect(await noop.canActivate(context)).toBe(true);
  expect(received).toBe("Bearer test");
  const mismatch = new AuthGuard({ authenticate: async () => ({ providerId: "provider-b" }) });
  await expect(mismatch.canActivate(context)).rejects.toThrow("Forbidden");
});
