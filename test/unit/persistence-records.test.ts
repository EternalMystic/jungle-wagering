import { describe, expect, test } from "bun:test";
import { type WalletRecord, walletFromRecord } from "../../src/infrastructure/persistence/records";

const base: WalletRecord = {
  id: "w",
  player_id: "p",
  currency: "BRL",
  balance_amount: "1000.00",
  version: 1,
  created_at: "2026-10-29 21:21:20.93+00",
  updated_at: "2026-10-29 21:21:20+00",
};

describe("mappers de persistência (fronteira com o driver)", () => {
  test.each([
    ["2026-10-29 21:21:20.93+00", "2026-10-29T21:21:20.930Z"],
    ["2026-10-29 21:21:20.261612+00", "2026-10-29T21:21:20.261Z"],
    ["2026-10-29 18:21:20-03", "2026-10-29T21:21:20.000Z"],
    ["2026-10-30 02:51:20.5+05:30", "2026-10-29T21:21:20.500Z"],
  ])("TIMESTAMPTZ textual %s → %s", (raw, iso) => {
    expect(walletFromRecord({ ...base, created_at: raw }).createdAt.toISOString()).toBe(iso);
  });

  test("Date já pronto passa intacto; inteiro textual vira number", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const w = walletFromRecord({ ...base, created_at: at, version: "7" });
    expect(w.createdAt).toBe(at);
    expect(w.version).toBe(7);
  });

  test("formato inesperado é erro, nunca data inventada", () => {
    expect(() => walletFromRecord({ ...base, created_at: "ontem" })).toThrow();
  });

  test("saldo vem da string NUMERIC sem passar por number", () => {
    expect(walletFromRecord({ ...base, balance_amount: "999999999999999999.99" }).balance.toString()).toBe("999999999999999999.99");
  });
});
