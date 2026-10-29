/**
 * Unidade do use case com repositórios FALSOS em memória (só aqui, em test/unit: a garantia
 * real de idempotência/concorrência é provada contra o PostgreSQL em test/acceptance).
 * Foco: ordem das decisões e o que é escrito em cada caminho.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IdempotencyConflictError, IdempotencyRaceLostError, InvalidCommandError } from "../../../src/application/errors";
import { OpenWallet } from "../../../src/application/open-wallet";
import type { TransactionalRepositories, UnitOfWork } from "../../../src/application/ports/unit-of-work";
import {
  ProcessWagerTransaction,
  REFERENCE_FIRST_RETRY_MS,
  type WagerCommand,
} from "../../../src/application/process-wager-transaction";
import type { WalletLedgerEntry } from "../../../src/domain/ledger-entry";
import { Money } from "../../../src/domain/money";
import type { OutboxMessage } from "../../../src/domain/outbox-message";
import { payloadHash } from "../../../src/domain/payload-hash";
import { WagerTransaction } from "../../../src/domain/wager-transaction";
import { Wallet } from "../../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const NOW = new Date("2026-10-29T12:00:00.000Z");

class FakeStore {
  wallets: Wallet[] = [];
  transactions: WagerTransaction[] = [];
  ledger: WalletLedgerEntry[] = [];
  outbox: OutboxMessage[] = [];
  /** simula perder a corrida do INSERT: antes do 23505, "outra transação" confirma isto */
  raceWinner: WagerTransaction | undefined;
  private committedByOthers: WagerTransaction[] = [];
  runs = 0;

  // reidrata cópias, como o banco faria: o use case nunca segura a instância persistida
  private copyWallet(w: Wallet): Wallet {
    return Wallet.rehydrate(w.toState());
  }

  repositories(): TransactionalRepositories {
    return {
      wallets: {
        lockById: async (id) => {
          const w = this.wallets.find((x) => x.id === id);
          return w && this.copyWallet(w);
        },
        findById: async (id) => this.wallets.find((x) => x.id === id),
        insert: async (w) => {
          this.wallets.push(this.copyWallet(w));
        },
        saveMovement: async (w) => {
          this.wallets = this.wallets.map((x) => (x.id === w.id ? this.copyWallet(w) : x));
        },
      },
      transactions: {
        findById: async (id) => this.transactions.find((t) => t.id === id),
        findByIdempotencyKey: async (key) => this.transactions.find((t) => t.idempotencyKey === key),
        findByProviderExternalId: async (p, e) => this.transactions.find((t) => t.providerId === p && t.externalTransactionId === e),
        hasProcessedReversal: async (id) =>
          this.transactions.some((t) => t.referenceTransactionId === id && t.status === "PROCESSED" && t.requiresReference()),
        insert: async (t) => {
          if (this.raceWinner !== undefined) {
            this.committedByOthers.push(this.raceWinner);
            this.raceWinner = undefined;
            throw new IdempotencyRaceLostError("23505 uq_tx_idempotency_key");
          }
          this.transactions.push(WagerTransaction.rehydrate(t.toState()));
        },
      },
      ledger: {
        append: async (e) => {
          this.ledger.push(e);
        },
      },
      outbox: {
        add: async (m) => {
          this.outbox.push(m);
        },
      },
    };
  }

  /** Transação atômica de mentira: escreve num rascunho e só publica se `work` não lançar. */
  uow(): UnitOfWork {
    return {
      run: async (work) => {
        this.runs++;
        const snapshot = { w: [...this.wallets], t: [...this.transactions], l: [...this.ledger], o: [...this.outbox] };
        try {
          return await work(this.repositories());
        } catch (error) {
          this.wallets = snapshot.w;
          this.transactions = [...snapshot.t, ...this.committedByOthers];
          this.committedByOthers = [];
          this.ledger = snapshot.l;
          this.outbox = snapshot.o;
          throw error;
        }
      },
    };
  }

  eventTypes(): string[] {
    return this.outbox.map((m) => m.eventType);
  }
}

let store: FakeStore;
let seq = 0;
const ids = { next: () => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };
const clock = { now: () => NOW };
let walletId: string;
const PLAYER = "11111111-1111-4111-8111-111111111111";

function command(overrides: Partial<WagerCommand> = {}): WagerCommand {
  const ext = overrides.externalTransactionId ?? "bet-1";
  return {
    idempotencyKey: `provider-a:${ext}`,
    providerId: "provider-a",
    externalTransactionId: ext,
    playerId: PLAYER,
    walletId,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: brl("80.00"),
    correlationId: "corr-1",
    ...overrides,
  };
}

const submit = (c: WagerCommand) => new ProcessWagerTransaction(store.uow(), clock, ids).execute(c);

beforeEach(async () => {
  store = new FakeStore();
  const opened = await new OpenWallet(store.uow(), clock, ids).execute({
    playerId: PLAYER,
    initialBalance: brl("100.00"),
    correlationId: "corr-0",
  });
  walletId = opened.id;
  store.outbox = [];
  store.runs = 0;
});

describe("OpenWallet", () => {
  test("saldo inicial > 0 → OPENING PROCESSED + CREDIT v1 + eventos, na mesma unidade de trabalho", async () => {
    const s = new FakeStore();
    const view = await new OpenWallet(s.uow(), clock, ids).execute({ playerId: PLAYER, initialBalance: brl("10.00"), correlationId: "c" });
    expect(view).toMatchObject({ playerId: PLAYER, version: 1 });
    expect(view.balance.equals(brl("10.00"))).toBe(true);
    expect(s.runs).toBe(1);
    expect(s.transactions.map((t) => [t.kind, t.status, t.resultBalance?.toString()])).toEqual([["OPENING", "PROCESSED", "10.00"]]);
    expect(s.ledger.map((e) => [e.direction, e.money.toString(), e.walletVersion])).toEqual([["CREDIT", "10.00", 1]]);
    expect(s.eventTypes()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("saldo inicial 0.00 → só a wallet, sem OPENING nem lançamento", async () => {
    const s = new FakeStore();
    await new OpenWallet(s.uow(), clock, ids).execute({ playerId: PLAYER, initialBalance: brl("0.00"), correlationId: "c" });
    expect(s.wallets).toHaveLength(1);
    expect(s.transactions).toHaveLength(0);
    expect(s.ledger).toHaveLength(0);
  });
});

describe("ProcessWagerTransaction — caminho feliz e rejeição", () => {
  test("BET aplicada: PROCESSED com o saldo pós-débito, 1 lançamento, 2 eventos", async () => {
    const res = await submit(command());
    expect(res).toMatchObject({ status: "PROCESSED", idempotentReplay: false, failureCode: undefined });
    expect(res.balance?.toString()).toBe("20.00");
    expect(store.wallets[0]?.balance.toString()).toBe("20.00");
    expect(store.wallets[0]?.version).toBe(2);
    expect(store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
    expect(store.eventTypes()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("BET sem saldo: REJECTED/INSUFFICIENT_FUNDS persistida com o saldo observado; sem lançamento", async () => {
    const res = await submit(command({ money: brl("100.01") }));
    expect(res).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    expect(res.balance?.toString()).toBe("100.00");
    expect(store.transactions.find((t) => t.kind === "BET")?.status).toBe("REJECTED");
    expect(store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(0);
    expect(store.wallets[0]?.version).toBe(1);
    expect(store.eventTypes()).toEqual(["WagerTransactionRejected"]);
  });

  test("wallet inexistente: 422 WALLET_NOT_FOUND sem nada persistido (D6)", async () => {
    const res = await submit(command({ walletId: "99999999-9999-4999-8999-999999999999" }));
    expect(res).toEqual({
      transactionId: undefined,
      status: "REJECTED",
      balance: undefined,
      failureCode: "WALLET_NOT_FOUND",
      idempotentReplay: false,
    });
    expect(store.transactions.filter((t) => t.kind !== "OPENING")).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  test("OPENING submetido → InvalidCommandError, sem abrir unidade de trabalho", async () => {
    await expect(submit(command({ kind: "OPENING" }))).rejects.toBeInstanceOf(InvalidCommandError);
    expect(store.runs).toBe(0);
  });

  test("REFUND sem referência no domínio → InvalidCommandError antes de qualquer lock", async () => {
    await expect(submit(command({ kind: "REFUND" }))).rejects.toBeInstanceOf(InvalidCommandError);
    expect(store.runs).toBe(0);
  });
});

describe("ProcessWagerTransaction — idempotência (§9, D4)", () => {
  test("mesma key + mesmo payload → replay com o resultado ORIGINAL, mesmo depois de o saldo mudar", async () => {
    const original = await submit(command());
    await submit(command({ externalTransactionId: "win-1", kind: "WIN", money: brl("30.00") }));
    expect(store.wallets[0]?.balance.toString()).toBe("50.00");

    const replay = await submit(command());
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.toString()).toBe("20.00");
    expect(store.transactions.filter((t) => t.kind === "BET")).toHaveLength(1);
    expect(store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
  });

  test("replay de uma rejeição devolve a mesma rejeição", async () => {
    const original = await submit(command({ money: brl("500.00") }));
    const replay = await submit(command({ money: brl("500.00") }));
    expect(replay).toMatchObject({ transactionId: original.transactionId, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: true });
  });

  test.each([
    ["valor", { money: brl("79.99") }],
    ["kind", { kind: "WIN" as const }],
    ["rodada", { roundId: "round-2" }],
    ["jogo", { gameId: "game-2" }],
    ["player", { playerId: "22222222-2222-4222-8222-222222222222" }],
  ])("mesma key com %s diferente → IdempotencyConflictError, nada novo gravado", async (_label, divergent) => {
    await submit(command());
    const before = { tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length };
    await expect(submit(command({ ...divergent, idempotencyKey: "provider-a:bet-1" }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect({ tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length }).toEqual(before);
  });

  test("mesmo (providerId, externalTransactionId) com OUTRA key → conflito, não novo débito", async () => {
    await submit(command());
    await expect(submit(command({ idempotencyKey: "client-generated-key" }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
  });

  test("23505 na key (corrida perdida) → rollback, releitura e replay do vencedor", async () => {
    const winnerCommand = command();
    // o vencedor tem o MESMO payload (mesmo hash): a releitura vira replay, não conflito
    const winner = WagerTransaction.create({
      id: "winner-tx",
      providerId: winnerCommand.providerId,
      externalTransactionId: winnerCommand.externalTransactionId,
      idempotencyKey: winnerCommand.idempotencyKey,
      payloadHash: payloadHash(winnerCommand),
      walletId,
      playerId: PLAYER,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: brl("80.00"),
      correlationId: "other",
      createdAt: NOW,
    });
    winner.markProcessed({ resultBalance: brl("20.00"), at: NOW });
    store.raceWinner = winner;

    const res = await submit(winnerCommand);
    expect(store.runs).toBe(2);
    expect(res).toMatchObject({ transactionId: "winner-tx", status: "PROCESSED", idempotentReplay: true });
    expect(res.balance?.toString()).toBe("20.00");
    // a tentativa perdedora não deixou lançamento nem evento
    expect(store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });
});

describe("ProcessWagerTransaction — reversões e referência fora de ordem (D7, D8)", () => {
  test("REFUND antes da BET → PENDING_REFERENCE agendado em +5 s, evento PendingReference, saldo intacto", async () => {
    const res = await submit(command({ externalTransactionId: "refund-1", kind: "REFUND", referenceExternalTransactionId: "bet-1" }));
    expect(res).toMatchObject({ status: "PENDING_REFERENCE", balance: undefined, idempotentReplay: false });
    const pending = store.transactions.find((t) => t.kind === "REFUND");
    expect(pending?.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + REFERENCE_FIRST_RETRY_MS);
    expect(store.eventTypes()).toEqual(["WagerTransactionPendingReference"]);
    expect(store.wallets[0]?.version).toBe(1);
  });

  test("REFUND depois da BET → crédito ligado à BET; segundo REFUND (outro id) → REFERENCE_ALREADY_REVERSED", async () => {
    const bet = await submit(command());
    const refund = await submit(command({ externalTransactionId: "refund-1", kind: "REFUND", referenceExternalTransactionId: "bet-1" }));
    expect(refund).toMatchObject({ status: "PROCESSED" });
    expect(refund.balance?.toString()).toBe("100.00");
    expect(store.transactions.find((t) => t.id === refund.transactionId)?.referenceTransactionId).toBe(bet.transactionId);

    const rollback = await submit(command({ externalTransactionId: "rb-1", kind: "ROLLBACK", referenceExternalTransactionId: "bet-1" }));
    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
    expect(store.wallets[0]?.balance.toString()).toBe("100.00");
  });

  test("ROLLBACK de WIN já gasto → REJECTED/REVERSAL_INSUFFICIENT_FUNDS (§7.9), auditável", async () => {
    await submit(command({ externalTransactionId: "win-1", kind: "WIN", money: brl("50.00") }));
    await submit(command({ externalTransactionId: "bet-2", money: brl("150.00") }));
    const res = await submit(command({ externalTransactionId: "rb-1", kind: "ROLLBACK", money: brl("50.00"), referenceExternalTransactionId: "win-1" }));
    expect(res).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    expect(store.transactions.find((t) => t.externalTransactionId === "rb-1")?.status).toBe("REJECTED");
  });
});
