/**
 * Cliente HTTP caixa-preta da API (§9). Não importa nada de `src/`: fala com o
 * processo real pela rede. Corpos são `unknown` (fronteira de I/O) e são
 * estreitados nos testes por `expect(...).toMatchObject` e pelos helpers abaixo.
 */
import { randomUUID } from "node:crypto";

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
  /** instante (performance.now) em que a requisição saiu e em que a resposta chegou */
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export interface WagerRequestBody {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyJson;
  readonly referenceExternalTransactionId?: string;
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const startedAt = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const finishedAt = performance.now();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body, headers: res.headers, startedAt, finishedAt };
  }

  createWallet(playerId: string, initialBalance: MoneyJson): Promise<HttpResult> {
    return this.request("POST", "/wallets", { body: { playerId, initialBalance } });
  }

  getWallet(walletId: string): Promise<HttpResult> {
    return this.request("GET", `/wallets/${walletId}`);
  }

  submit(body: WagerRequestBody, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`): Promise<HttpResult> {
    return this.request("POST", "/wagering/transactions", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }
}

export function brl(amount: string): MoneyJson {
  return { amount, currency: "BRL" };
}

export function newPlayerId(): string {
  return randomUUID();
}

export function asRecord(value: unknown, what = "corpo"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}: esperado objeto JSON, recebido ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export function stringField(value: unknown, field: string): string {
  const v = asRecord(value)[field];
  if (typeof v !== "string") {
    throw new Error(`campo "${field}" ausente ou não-string em ${JSON.stringify(value)}`);
  }
  return v;
}

/** Abre uma wallet pela API e devolve o id; falha com o corpo da resposta se não for 201. */
export async function openWalletViaApi(api: ApiClient, playerId: string, initial: MoneyJson): Promise<string> {
  const res = await api.createWallet(playerId, initial);
  if (res.status !== 201) {
    throw new Error(`POST /wallets → ${res.status} ${JSON.stringify(res.body)} (esperado 201)`);
  }
  return stringField(res.body, "id");
}

export function bet(
  walletId: string,
  playerId: string,
  externalTransactionId: string,
  amount: string,
  overrides: Partial<WagerRequestBody> = {},
): WagerRequestBody {
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: brl(amount),
    ...overrides,
  };
}
