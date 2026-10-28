import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/errors";
import { Money } from "../../../src/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — portão de entrada (D2)", () => {
  test.each([
    ["0.00", 0n],
    ["0.01", 1n],
    ["1.00", 100n],
    ["25.00", 2500n],
    ["975.50", 97550n],
    ["100000000000000000.99", 10000000000000000099n],
    ["999999999999999999.99", 99999999999999999999n],
  ])("aceita %p como %p centavos, sem perda", (amount, cents) => {
    const m = brl(amount);
    expect(m.toCents()).toBe(cents);
    expect(m.toString()).toBe(amount);
    expect(m.toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each([
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["notação científica", "1e3"],
    ["notação científica com casas", "1.00e2"],
    ["string vazia", ""],
    ["espaço à esquerda", " 1.00"],
    ["espaço à direita", "1.00 "],
    ["uma casa", "1.0"],
    ["três casas", "1.000"],
    ["três casas que arredondariam", "10.005"],
    ["sem casas", "1"],
    ["meia casa", "1.5"],
    ["negativo", "-1.00"],
    ["negativo zero", "-0.00"],
    ["sinal de mais", "+1.00"],
    ["zero à esquerda", "01.00"],
    ["só fração", ".50"],
    ["ponto final", "1."],
    ["vírgula decimal", "1,00"],
    ["separador de milhar", "1,000.00"],
    ["hexadecimal", "0x10"],
    ["underscore numérico", "1_000.00"],
    ["dígitos não ASCII", "١.٠٠"],
    ["19 dígitos inteiros (estoura NUMERIC(20,2))", "1000000000000000000.00"],
    ["quebra de linha", "1.00\n"],
  ])("rejeita %s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    [123, "number"],
    [null, "null"],
    [undefined, "undefined"],
    [100n, "bigint"],
    [{ toString: () => "1.00" }, "objeto"],
  ])("rejeita amount não-string em runtime (%p, %s)", (amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "R$", "12A", " BRL"])("rejeita moeda inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("aceita outras moedas ISO-4217 (modelo multi-moeda)", () => {
    expect(Money.from({ amount: "1.00", currency: "USD" }).currency).toBe("USD");
  });
});

describe("Money — aritmética exata e imutável", () => {
  test("0.10 + 0.20 é exatamente 0.30 (sem float)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("operações devolvem nova instância e não alteram os operandos", () => {
    const a = brl("100.00");
    const b = brl("80.00");
    const c = a.subtract(b);
    expect(c).not.toBe(a);
    expect(a.toString()).toBe("100.00");
    expect(b.toString()).toBe("80.00");
    expect(c.toString()).toBe("20.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("subtract pode ficar negativo internamente; negate inverte o sinal", () => {
    const d = brl("20.00").subtract(brl("80.00"));
    expect(d.isNegative()).toBe(true);
    expect(d.toString()).toBe("-60.00");
    expect(d.negate().toString()).toBe("60.00");
    expect(brl("0.00").negate().isZero()).toBe(true);
    expect(brl("0.00").negate().toString()).toBe("0.00");
    expect(brl("0.05").negate().toString()).toBe("-0.05");
  });

  test("predicados e comparação", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);
    expect(brl("19.99").isLessThan(brl("20.00"))).toBe(true);
    expect(brl("20.00").isLessThan(brl("20.00"))).toBe(false);
    expect(brl("20.00").isGreaterThanOrEqual(brl("20.00"))).toBe(true);
    expect(brl("20.00").equals(brl("20.00"))).toBe(true);
    expect(brl("20.00").equals(Money.from({ amount: "20.00", currency: "USD" }))).toBe(false);
  });

  test("resultado acima da capacidade de NUMERIC(20,2) é erro, não estouro silencioso", () => {
    expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(InvalidMoneyError);
    expect(() => brl("0.00").subtract(brl("999999999999999999.99")).subtract(brl("0.01"))).toThrow(InvalidMoneyError);
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
    ["isGreaterThanOrEqual", (a: Money, b: Money) => a.isGreaterThanOrEqual(b)],
  ])("%s entre BRL e USD lança CurrencyMismatchError", (_name, op) => {
    expect(() => op(brl("10.00"), usd)).toThrow(CurrencyMismatchError);
  });

  test("o erro identifica as duas moedas", () => {
    try {
      brl("1.00").add(usd);
      throw new Error("deveria ter lançado");
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).expected).toBe("BRL");
      expect((error as CurrencyMismatchError).actual).toBe("USD");
    }
  });
});
