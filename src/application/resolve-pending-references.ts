import { BusinessFailureCode } from "../domain/failure-codes";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { Clock } from "./ports/clock";
import type { IdGenerator } from "./ports/id-generator";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work";
import { settleWager } from "./settle-wager";
import { decideWager } from "./wager-rules";

export const REFERENCE_MAX_ATTEMPTS = 8;
export const REFERENCE_TTL_MS = 915_000;
const EAGER_BATCH_SIZE = 50;

export interface PendingClaim {
  readonly transactionId: string;
  readonly walletId: string;
  readonly claimUntil: Date;
}

async function resolve(r: TransactionalRepositories, wallet: Wallet, tx: WagerTransaction,
  at: Date, ids: IdGenerator, scheduled: boolean): Promise<void> {
  const reference = tx.referenceExternalTransactionId === undefined ? undefined :
    await r.transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
  const reversed = reference !== undefined && tx.requiresReference() ? await r.transactions.hasProcessedReversal(reference.id) : false;
  let decision = decideWager({ wallet, transaction: tx, reference, referenceAlreadyReversed: reversed });
  if (decision.outcome === "WAIT_REFERENCE") {
    if (!scheduled) return;
    const exhausted = tx.referenceAttempts + 1 >= REFERENCE_MAX_ATTEMPTS || at.getTime() - tx.createdAt.getTime() >= REFERENCE_TTL_MS;
    tx.scheduleReferenceRetry(new Date(at.getTime() + Math.min(5000 * 2 ** Math.min(tx.referenceAttempts + 1, 6), 300_000)));
    if (!exhausted) {
      await r.transactions.savePending(tx);
      return;
    }
    decision = { outcome: "REJECT", failureCode: BusinessFailureCode.ReferenceNotFound };
  }
  await settleWager(r, wallet, tx, decision, at, ids, true);
}

/** Wallet já travada; também resolve cadeias de dependências sem recursão. */
export async function resolveEagerly(r: TransactionalRepositories, wallet: Wallet,
  reference: WagerTransaction, at: Date, ids: IdGenerator): Promise<void> {
  const ready = [reference];
  for (let i = 0; i < ready.length; i++) {
    const parent = ready[i]!;
    if (!parent.isTerminal()) continue;
    for (;;) {
      const waiting = await r.transactions.findPendingReferencing(wallet.id, parent.providerId, parent.externalTransactionId, EAGER_BATCH_SIZE);
      for (const tx of waiting) {
        await resolve(r, wallet, tx, at, ids, false);
        if (tx.isTerminal()) ready.push(tx);
      }
      if (waiting.length < EAGER_BATCH_SIZE) break;
    }
  }
}

export class ResolvePendingReferences {
  constructor(private readonly uow: UnitOfWork, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async execute(claim: PendingClaim): Promise<void> {
    await this.uow.run(async (r) => {
      const wallet = await r.wallets.lockById(claim.walletId);
      if (wallet === undefined) return;
      const tx = await r.transactions.lockById(claim.transactionId);
      if (tx === undefined || tx.walletId !== wallet.id || tx.status !== WagerTransactionStatus.PendingReference ||
        tx.nextReferenceAttemptAt?.getTime() !== claim.claimUntil.getTime()) return;
      const at = this.clock.now();
      await resolve(r, wallet, tx, at, this.ids, true);
      if (tx.isTerminal()) await resolveEagerly(r, wallet, tx, at, this.ids);
    });
  }
}
