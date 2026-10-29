import type { IntegrationEvent } from "../domain/events/integration-event";
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from "../domain/events/wager-transaction-events";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { IdGenerator } from "./ports/id-generator";
import type { TransactionalRepositories } from "./ports/unit-of-work";
import type { WagerDecision } from "./wager-rules";

export const REFERENCE_FIRST_RETRY_MS = 5000;

/** Chamado sob o lock da wallet; efeito, ledger e eventos têm a mesma fronteira SQL. */
export async function settleWager(r: TransactionalRepositories, wallet: Wallet, tx: WagerTransaction,
  decision: WagerDecision, at: Date, ids: IdGenerator, existing = false): Promise<void> {
  const ctx = () => ({ eventId: ids.next(), correlationId: tx.correlationId, occurredAt: at });
  const events: IntegrationEvent<unknown>[] = [];
  const save = () => existing ? r.transactions.savePending(tx) : r.transactions.insert(tx);
  switch (decision.outcome) {
    case "APPLY": {
      const entry = wallet.apply(decision.direction, { entryId: ids.next(), transactionId: tx.id, money: tx.money, at });
      tx.markProcessed({ resultBalance: wallet.balance, at, referenceTransactionId: decision.referenceTransactionId });
      await save();
      await r.wallets.saveMovement(wallet, entry);
      await r.ledger.append(entry);
      events.push(WagerTransactionProcessed.from(tx, ctx()), WalletBalanceChanged.from(wallet, entry, ctx()));
      break;
    }
    case "RECORD":
      tx.markProcessed({ resultBalance: wallet.balance, at, referenceTransactionId: decision.referenceTransactionId });
      await save();
      events.push(WagerTransactionProcessed.from(tx, ctx()));
      break;
    case "REJECT":
      tx.reject(decision.failureCode, { resultBalance: wallet.balance, at });
      await save();
      events.push(WagerTransactionRejected.from(tx, ctx()));
      break;
    case "WAIT_REFERENCE":
      tx.markPendingReference(new Date(at.getTime() + REFERENCE_FIRST_RETRY_MS));
      await save();
      events.push(WagerTransactionPendingReference.from(tx, ctx()));
      break;
  }
  for (const event of events) await r.outbox.add(OutboxMessage.enqueue(event));
}
