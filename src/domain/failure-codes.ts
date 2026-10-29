/**
 * Taxonomia estável de `failureCode` (D6). Legível por máquina; o provedor decide por
 * ela se reenvia, corrige o payload ou desiste. Valores são contrato: nunca renomear.
 */
export const BusinessFailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  /** distinto de INSUFFICIENT_FUNDS (§7.9): reversão que deixaria saldo negativo */
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  BalanceLimitExceeded: "BALANCE_LIMIT_EXCEEDED",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  /** única rejeição NÃO persistida: não há wallet dona para a FK (D6) */
  WalletNotFound: "WALLET_NOT_FOUND",
  WalletPlayerMismatch: "WALLET_PLAYER_MISMATCH",
  /** referência não apareceu dentro do limite de tentativas (§7.1) */
  ReferenceNotFound: "REFERENCE_NOT_FOUND",
  ReferenceKindNotReversible: "REFERENCE_KIND_NOT_REVERSIBLE",
  /** provider, player, wallet, moeda ou rodada divergentes (§7.2) */
  ReferenceScopeMismatch: "REFERENCE_SCOPE_MISMATCH",
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  OpeningNotAllowed: "OPENING_NOT_ALLOWED",
} as const;
export type BusinessFailureCode = (typeof BusinessFailureCode)[keyof typeof BusinessFailureCode];

/** Falha permanente de infraestrutura (status FAILED, auditável). */
export const InfraFailureCode = {
  PermanentInfraError: "PERMANENT_INFRA_ERROR",
} as const;
export type InfraFailureCode = (typeof InfraFailureCode)[keyof typeof InfraFailureCode];

export type FailureCode = BusinessFailureCode | InfraFailureCode;

const BUSINESS_CODES: readonly string[] = Object.values(BusinessFailureCode);
const INFRA_CODES: readonly string[] = Object.values(InfraFailureCode);

export function isBusinessFailureCode(value: unknown): value is BusinessFailureCode {
  return typeof value === "string" && BUSINESS_CODES.includes(value);
}

export function isInfraFailureCode(value: unknown): value is InfraFailureCode {
  return typeof value === "string" && INFRA_CODES.includes(value);
}

export function isFailureCode(value: unknown): value is FailureCode {
  return isBusinessFailureCode(value) || isInfraFailureCode(value);
}
