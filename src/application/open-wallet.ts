import { DomainError } from "../domain/errors";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-events";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import type { Money } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { openingPayloadHash } from "../domain/payload-hash";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { InvalidCommandError } from "./errors";
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

/**
 * Abre a wallet (version 1) e, se o saldo inicial for > 0, a transação interna OPENING
 * PROCESSED + CREDIT v1 + eventos — tudo na MESMA transação SQL (§9). Wallet duplicada
 * para player+moeda sai do banco (`uq_wallet_player_currency`) como `WalletAlreadyExistsError`,
 * inclusive quando duas criações correm juntas.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const at = this.clock.now();
    const openingTransactionId = this.ids.next();
    let opened: ReturnType<typeof Wallet.open>;
    try {
      opened = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        at,
        openingTransactionId,
        openingEntryId: this.ids.next(),
      });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message);
      throw error;
    }
    const { wallet, openingEntry } = opened;

    await this.uow.run(async (repositories) => {
      await repositories.wallets.insert(wallet);
      if (openingEntry === undefined) return;

      const opening = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: wallet.balance,
        payloadHash: openingPayloadHash({ walletId: wallet.id, playerId: wallet.playerId, money: wallet.balance }),
        correlationId: command.correlationId,
        createdAt: at,
      });
      opening.markProcessed({ resultBalance: wallet.balance, at });
      await repositories.transactions.insert(opening);
      await repositories.ledger.append(openingEntry);

      const ctx = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
      await repositories.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())));
      await repositories.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())));
    });

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }
}
