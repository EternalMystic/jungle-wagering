import { describe, expect, test } from "bun:test";
import { DEFAULT_DATABASE_URL, InvalidConfigError, loadConfig } from "../../src/infrastructure/config/app-config";

describe("loadConfig", () => {
  test("usa os defaults do docker-compose quando o ambiente está vazio", () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBe(DEFAULT_DATABASE_URL);
    expect(config.aws.endpoint).toBe("http://localhost:4566");
    expect(config.queues).toEqual({
      wagerTransactions: "wager-transactions.fifo",
      wagerTransactionsDlq: "wager-transactions-dlq.fifo",
      walletEvents: "wallet-events.fifo",
    });
    expect(config.httpPort).toBe(3000);
  });

  test("respeita variáveis de ambiente", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@db:5432/x",
      AWS_ENDPOINT_URL: "http://sqs:4566",
      SQS_WAGER_QUEUE: "other.fifo",
      PORT: "8080",
    });
    expect(config.databaseUrl).toBe("postgresql://u:p@db:5432/x");
    expect(config.aws.endpoint).toBe("http://sqs:4566");
    expect(config.queues.wagerTransactions).toBe("other.fifo");
    expect(config.httpPort).toBe(8080);
  });

  test.each([
    ["DATABASE_URL", "mysql://x"],
    ["DATABASE_URL", "not a url"],
    ["AWS_ENDPOINT_URL", "ftp://x"],
    ["PORT", "80.5"],
    ["PORT", "1e3"],
    ["PORT", "0"],
    ["PORT", "70000"],
    ["SQS_WAGER_QUEUE", "standard-queue"],
  ])("rejeita %s=%p", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(InvalidConfigError);
  });
});
