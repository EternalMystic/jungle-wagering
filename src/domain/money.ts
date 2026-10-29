import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

/** DTO de contrato: valor como string decimal de escala fixa 2. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** D2: exatamente 2 casas, sem sinal, sem zero à esquerda, até 18 dígitos inteiros. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Capacidade de NUMERIC(20,2), em centavos. */
const MAX_ABS_CENTS = 10n ** 20n - 1n;

/**
 * Dinheiro exato: bigint em centavos + moeda ISO-4217. Imutável. Nunca arredonda —
 * entrada fora da escala é erro (D2). Negativos só existem como resultado interno
 * (`subtract`/`negate`); contratos de entrada passam por `from`, que os recusa.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`invalid amount ${JSON.stringify(String(amount))}: expected ^(0|[1-9]\\d{0,17})\\.\\d{2}$`);
    }
    const [units = "", fraction = ""] = amount.split(".");
    return new Money(BigInt(units) * 100n + BigInt(fraction), Money.checkedCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.checkedCurrency(currency));
  }

  /** Para mappers/reconstrução interna a partir de centavos já exatos. */
  static fromCents(cents: bigint, currency: string): Money {
    return Money.bounded(cents, Money.checkedCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.bounded(this.cents + other.cents, this.currency);
  }

  canAdd(other: Money): boolean {
    this.assertSameCurrency(other);
    const sum = this.cents + other.cents;
    return sum <= MAX_ABS_CENTS && sum >= -MAX_ABS_CENTS;
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.bounded(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents >= other.cents;
  }

  /** Mesma moeda e mesmo valor. Moedas diferentes ⇒ false (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toCents(): bigint {
    return this.cents;
  }

  /** Valor em string decimal de escala 2 (ex.: "975.00", "-0.05"). */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const units = (abs / 100n).toString();
    const fraction = (abs % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${units}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  assertSameCurrency(other: Money | string): void {
    const currency = typeof other === "string" ? other : other.currency;
    if (currency !== this.currency) throw new CurrencyMismatchError(this.currency, currency);
  }

  private static bounded(cents: bigint, currency: string): Money {
    if (cents > MAX_ABS_CENTS || cents < -MAX_ABS_CENTS) {
      throw new InvalidMoneyError("amount exceeds NUMERIC(20,2) capacity");
    }
    return new Money(cents, currency);
  }

  private static checkedCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency ${JSON.stringify(String(currency))}: expected ISO-4217 ^[A-Z]{3}$`);
    }
    return currency;
  }
}
