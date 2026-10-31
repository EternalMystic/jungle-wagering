import { WagerTransactionProcessed } from "../domain/events/wager-transaction-events";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import type { Money } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { openingPayloadHash } from "../domain/payload-hash";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { InvalidCommandError } from "./errors";
import { DomainError } from "../domain/errors";
import type { Clock } from "./ports/clock";
import type { IdGenerator } from "./ports/id-generator";
import type { UnitOfWork } from "./ports/unit-of-work";

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly correlationId: string;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
}

// Saldo inicial positivo gera OPENING, ledger e eventos no mesmo commit.
// A constraint player+moeda resolve criacoes concorrentes.
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const at = this.clock.now();
    const openingId = this.ids.next();
    let opened: ReturnType<typeof Wallet.open>;
    try {
      opened = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        at,
        openingTransactionId: openingId,
        openingEntryId: this.ids.next(),
      });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message);
      throw error;
    }
    const { wallet, openingEntry } = opened;
    await this.uow.run(async (repos) => {
      await repos.wallets.insert(wallet);
      if (openingEntry === undefined) return;

      const opening = WagerTransaction.createOpening({
        id: openingId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: wallet.balance,
        payloadHash: openingPayloadHash({ walletId: wallet.id, playerId: wallet.playerId, money: wallet.balance }),
        correlationId: command.correlationId,
        createdAt: at,
      });
      opening.markProcessed({ resultBalance: wallet.balance, at });
      await repos.transactions.insert(opening);
      await repos.ledger.append(openingEntry);

      // Cada evento precisa do seu id, mesmo saindo do mesmo commit.
      await repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, {
        eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at,
      })));

      await repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, {
        eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at,
      })));
    });

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }
}
