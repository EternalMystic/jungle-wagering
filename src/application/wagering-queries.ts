import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { UnitOfWork } from "./ports/unit-of-work";

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  wallet(walletId: string): Promise<Wallet | undefined> {
    return this.uow.run((repos) => repos.wallets.findById(walletId));
  }

  transaction(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.uow.run((r) => r.transactions.findById(transactionId));
  }

  transactionByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.uow.run((r) => r.transactions.findByProviderExternalId(providerId, externalTransactionId));
  }
}
