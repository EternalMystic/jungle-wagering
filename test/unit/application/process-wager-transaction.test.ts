/**
 * Unidade do use case com repositórios FALSOS em memória (só aqui, em test/unit: a garantia
 * real de idempotência/concorrência é provada contra o PostgreSQL em test/acceptance).
 * Foco: ordem das decisões e o que é escrito em cada caminho.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  IdempotencyRaceLostError,
  InboxPayloadMismatchError,
  InvalidCommandError,
} from "../../../src/application/errors";
import { OpenWallet } from "../../../src/application/open-wallet";
import { type FaultInjector, FaultPoint } from "../../../src/application/ports/fault-injector";
import type { TransactionalRepositories, UnitOfWork } from "../../../src/application/ports/unit-of-work";
import {
  ProcessWagerTransaction,
  REFERENCE_FIRST_RETRY_MS,
  type WagerCommand,
} from "../../../src/application/process-wager-transaction";
import { InboxMessage } from "../../../src/domain/inbox-message";
import type { WalletLedgerEntry } from "../../../src/domain/ledger-entry";
import { Money } from "../../../src/domain/money";
import type { OutboxMessage } from "../../../src/domain/outbox-message";
import { payloadHash } from "../../../src/domain/payload-hash";
import { WagerTransaction } from "../../../src/domain/wager-transaction";
import { Wallet } from "../../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const NOW = new Date("2026-10-29T12:00:00.000Z");

function copyInbox(m: InboxMessage, processedAt: Date | undefined): InboxMessage {
  const { messageId, consumerName, payloadHash: hash, receivedAt } = m;
  return InboxMessage.rehydrate({ messageId, consumerName, payloadHash: hash, receivedAt, processedAt });
}

class FakeStore {
  wallets: Wallet[] = [];
  transactions: WagerTransaction[] = [];
  ledger: WalletLedgerEntry[] = [];
  outbox: OutboxMessage[] = [];
  inbox: InboxMessage[] = [];
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
        lockById: async (id) => {
          const t = this.transactions.find((t) => t.id === id);
          return t && WagerTransaction.rehydrate(t.toState());
        },
        findPendingReferencing: async (wallet, provider, external, limit) => this.transactions
          .filter((t) => t.walletId === wallet && t.providerId === provider && t.referenceExternalTransactionId === external && t.status === "PENDING_REFERENCE")
          .slice(0, limit).map((t) => WagerTransaction.rehydrate(t.toState())),
        savePending: async (t) => {
          this.transactions = this.transactions.map((x) => x.id === t.id ? WagerTransaction.rehydrate(t.toState()) : x);
        },
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
      inbox: {
        insertIfAbsent: async (m) => {
          const found = this.inbox.find((x) => x.consumerName === m.consumerName && x.messageId === m.messageId);
          if (found !== undefined) return copyInbox(found, found.processedAt);
          this.inbox.push(copyInbox(m, undefined));
          return undefined;
        },
        markProcessed: async (m) => {
          this.inbox = this.inbox.map((x) =>
            x.consumerName === m.consumerName && x.messageId === m.messageId ? copyInbox(x, m.processedAt) : x,
          );
        },
      },
    };
  }

  /** Transação atômica de mentira: escreve num rascunho e só publica se `work` não lançar. */
  uow(): UnitOfWork {
    return {
      run: async (work) => {
        this.runs++;
        const snapshot = { w: [...this.wallets], t: [...this.transactions], l: [...this.ledger], o: [...this.outbox], i: [...this.inbox] };
        try {
          return await work(this.repositories());
        } catch (error) {
          this.wallets = snapshot.w;
          this.transactions = [...snapshot.t, ...this.committedByOthers];
          this.committedByOthers = [];
          this.ledger = snapshot.l;
          this.outbox = snapshot.o;
          this.inbox = snapshot.i;
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

describe("ProcessWagerTransaction — FaultInjector (D20)", () => {
  class RecordingFaults implements FaultInjector {
    readonly seen: { point: FaultPoint; transactions: number; outbox: number; runs: number }[] = [];
    constructor(private readonly s: FakeStore) {}
    checkpoint(point: FaultPoint): void {
      this.seen.push({ point, transactions: this.s.transactions.length, outbox: this.s.outbox.length, runs: this.s.runs });
    }
  }

  test("before-commit: dentro da transação, depois de TODAS as escritas (transação, ledger, outbox)", async () => {
    const faults = new RecordingFaults(store);
    const before = { transactions: store.transactions.length, outbox: store.outbox.length };
    await new ProcessWagerTransaction(store.uow(), clock, ids, faults).execute(command());
    expect(faults.seen).toEqual([
      { point: "before-commit", transactions: before.transactions + 1, outbox: before.outbox + 2, runs: store.runs },
    ]);
  });

  test("before-commit que aborta ⇒ nada confirmado (é o ponto de um SIGKILL antes do COMMIT)", async () => {
    const abort: FaultInjector = {
      checkpoint: (point) => {
        if (point === FaultPoint.BeforeCommit) throw new Error("killed");
      },
    };
    const snapshot = { t: store.transactions.length, l: store.ledger.length, o: store.outbox.length };
    await expect(new ProcessWagerTransaction(store.uow(), clock, ids, abort).execute(command())).rejects.toThrow("killed");
    expect({ t: store.transactions.length, l: store.ledger.length, o: store.outbox.length }).toEqual(snapshot);
    expect(store.wallets[0]?.balance.toString()).toBe("100.00");
  });

  test("replay não passa pelo before-commit (nada a confirmar)", async () => {
    await submit(command());
    const faults = new RecordingFaults(store);
    const res = await new ProcessWagerTransaction(store.uow(), clock, ids, faults).execute(command());
    expect(res.idempotentReplay).toBe(true);
    expect(faults.seen).toEqual([]);
  });
});

describe("ProcessWagerTransaction — inbox da fila (passo 2, mesma unidade de trabalho)", () => {
  const delivery = (messageId = "msg-1") => ({ consumerName: "wager-transactions-consumer", messageId });
  const viaQueue = (c: WagerCommand, messageId?: string) =>
    new ProcessWagerTransaction(store.uow(), clock, ids).execute(c, delivery(messageId));
  const debits = () => store.ledger.filter((e) => e.direction === "DEBIT");

  test("mensagem nova: efeito + inbox marcada processada no mesmo commit", async () => {
    const res = await viaQueue(command());
    expect(res).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
    expect(store.runs).toBe(1);
    const transaction = store.transactions.find((t) => t.kind === "BET");
    expect(transaction).toBeDefined();
    expect(store.inbox).toHaveLength(1);
    expect(store.inbox[0]?.messageId).toBe("msg-1");
    expect(store.inbox[0]?.isProcessed()).toBe(true);
    expect(store.inbox[0]?.payloadHash).toBe(transaction?.payloadHash);
    expect(debits()).toHaveLength(1);
  });

  test("redelivery (mesmo messageId, mesmo payload) 3×: resultado ORIGINAL, nada novo escrito", async () => {
    const first = await viaQueue(command());
    const before = { tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length, inbox: store.inbox.length };
    for (let i = 0; i < 3; i++) {
      const again = await viaQueue(command());
      expect(again).toEqual({ ...first, idempotentReplay: true });
    }
    expect({ tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length, inbox: store.inbox.length }).toEqual(before);
  });

  test("redelivery é reconhecida PELA INBOX, mesmo com outra Idempotency-Key (não chega a virar 409)", async () => {
    const first = await viaQueue(command());
    const again = await viaQueue(command({ idempotencyKey: "other-key" }));
    // a key mudou, mas o hash do payload é o mesmo: a inbox responde antes da busca pela key
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(debits()).toHaveLength(1);
  });

  test("mesmo messageId com payload diferente → InboxPayloadMismatchError, nada confirmado", async () => {
    await viaQueue(command());
    const before = { tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length, inbox: store.inbox.length };
    await expect(viaQueue(command({ externalTransactionId: "bet-2" }))).rejects.toBeInstanceOf(InboxPayloadMismatchError);
    expect({ tx: store.transactions.length, ledger: store.ledger.length, outbox: store.outbox.length, inbox: store.inbox.length }).toEqual(before);
  });

  test("conflito de idempotência pela fila: lança e a inbox NÃO é confirmada (vai para a DLQ, não some)", async () => {
    await submit(command());
    await expect(viaQueue(command({ money: brl("1.00") }), "msg-conflict")).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(store.inbox).toHaveLength(0);
  });

  test("mesma operação por HTTP e depois pela fila: replay do original; inbox registrada", async () => {
    const http = await submit(command());
    const queue = await viaQueue(command(), "msg-after-http");
    expect(queue).toEqual({ ...http, idempotentReplay: true });
    expect(store.inbox.map((m) => [m.messageId, m.isProcessed()])).toEqual([["msg-after-http", true]]);
    expect(debits()).toHaveLength(1);
  });

  test("WALLET_NOT_FOUND pela fila: inbox confirmada; redelivery depois de a wallet existir continua WALLET_NOT_FOUND", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const res = await viaQueue(command({ walletId: missing }), "msg-missing");
    expect(res).toMatchObject({ failureCode: "WALLET_NOT_FOUND", idempotentReplay: false });
    expect(store.inbox.map((m) => m.isProcessed())).toEqual([true]);

    const opened = Wallet.open({
      id: missing,
      playerId: PLAYER,
      initialBalance: brl("100.00"),
      at: NOW,
      openingTransactionId: ids.next(),
      openingEntryId: ids.next(),
    });
    store.wallets.push(opened.wallet);
    const again = await viaQueue(command({ walletId: missing }), "msg-missing");
    expect(again).toMatchObject({ failureCode: "WALLET_NOT_FOUND", idempotentReplay: true, transactionId: undefined });
    expect(store.transactions.filter((t) => t.walletId === missing)).toHaveLength(0);
  });

  test("corrida 23505 pela fila: a nova tentativa grava a inbox de novo (rollback desfez a primeira)", async () => {
    const c = command();
    const winner = WagerTransaction.create({
      id: "winner-tx",
      providerId: c.providerId,
      externalTransactionId: c.externalTransactionId,
      idempotencyKey: c.idempotencyKey,
      payloadHash: payloadHash(c),
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
    const res = await viaQueue(c, "msg-race");
    expect(store.runs).toBe(2);
    expect(res).toMatchObject({ transactionId: "winner-tx", idempotentReplay: true });
    expect(store.inbox.map((m) => [m.messageId, m.isProcessed()])).toEqual([["msg-race", true]]);
  });
});
