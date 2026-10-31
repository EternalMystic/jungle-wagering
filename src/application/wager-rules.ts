import { BusinessFailureCode } from "../domain/failure-codes";
import { LedgerDirection } from "../domain/ledger-entry";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";

// Quem chama busca a referencia e grava o resultado, com a wallet travada.
export type WagerDecision =
  | { readonly outcome: "APPLY"; readonly direction: LedgerDirection; readonly referenceTransactionId?: string }
  | { readonly outcome: "RECORD"; readonly referenceTransactionId?: string }
  | { readonly outcome: "REJECT"; readonly failureCode: BusinessFailureCode }
  | { readonly outcome: "WAIT_REFERENCE" };

export interface DecideWagerInput {
  /** wallet travada (FOR UPDATE) */
  readonly wallet: Wallet;
  /** a transação submetida, em PENDING */
  readonly transaction: WagerTransaction;
  /** resolvida por (providerId, referenceExternalTransactionId); ausente se ainda não chegou */
  readonly reference: WagerTransaction | undefined;
  /** já existe REFUND/ROLLBACK PROCESSED apontando para a referência (D7, leitura estrita) */
  readonly referenceAlreadyReversed: boolean;
}

/** Que kinds cada operação pode referenciar (§7.3; WIN/LOSS: "a BET da mesma rodada"). */
const REFERENCEABLE: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const reject = (failureCode: BusinessFailureCode): WagerDecision => ({ outcome: "REJECT", failureCode });

export function decideWager(input: DecideWagerInput): WagerDecision {
  const { wallet, transaction: tx, reference } = input;

  if (tx.money.currency !== wallet.currency) return reject(BusinessFailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(BusinessFailureCode.WalletPlayerMismatch);

  let referenceTransactionId: string | undefined;
  if (tx.referenceExternalTransactionId !== undefined) {
    if (REFERENCEABLE[tx.kind].length === 0) return reject(BusinessFailureCode.ReferenceKindNotReversible);
    if (reference === undefined) return { outcome: "WAIT_REFERENCE" };
    const refusal = checkReference(tx, reference, input.referenceAlreadyReversed);
    if (refusal === "WAIT") return { outcome: "WAIT_REFERENCE" };
    if (refusal !== undefined) return reject(refusal);
    referenceTransactionId = reference.id;
  }
  const linked = referenceTransactionId === undefined ? {} : { referenceTransactionId };

  if (!tx.affectsBalance()) return { outcome: "RECORD", ...linked };

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit && !wallet.balance.canAdd(tx.money)) {
    return reject(BusinessFailureCode.BalanceLimitExceeded);
  }
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // §7.9: reversão sem saldo é operacionalmente diferente de aposta sem saldo
    return reject(
      tx.requiresReference() ? BusinessFailureCode.ReversalInsufficientFunds : BusinessFailureCode.InsufficientFunds,
    );
  }
  return { outcome: "APPLY", direction, ...linked };
}

/** Escopo (§7.2) → tipo (§7.3) → estado → valor (§7.5) → reversão única (§7.4, D7). */
function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): BusinessFailureCode | "WAIT" | undefined {
  const sameScope =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameScope) return BusinessFailureCode.ReferenceScopeMismatch;
  if (!REFERENCEABLE[tx.kind].includes(reference.kind)) return BusinessFailureCode.ReferenceKindNotReversible;
  if (!reference.isTerminal()) return "WAIT";
  if (reference.status !== WagerTransactionStatus.Processed) return BusinessFailureCode.ReferenceNotProcessed;
  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) return BusinessFailureCode.ReferenceAmountMismatch;
    if (alreadyReversed) return BusinessFailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}
