import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { WalletReads, ReconciliationResult } from "../../application/ports/wallet-reads";
import type { ReconcileWallet } from "../../application/reconcile-wallet";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import { AuthGuard } from "./auth.guard";
import { HttpProblem } from "./http-problem";
import { notFoundUnlessUuid } from "./wagering/wallets.controller";

export const WALLET_READS = Symbol("WALLET_READS");
export const RECONCILE_WALLET = Symbol("RECONCILE_WALLET");

const invalid = () => new HttpProblem(400, "INVALID_PAYLOAD", "invalid ledger cursor or limit");

function pagination(cursor: unknown, limit: unknown): { after: number; limit: number } {
  let after = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length > 24 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^[1-9]\d{0,15}$/.test(decoded) || Buffer.from(decoded).toString("base64url") !== cursor) throw invalid();
    after = Number(decoded);
    if (!Number.isSafeInteger(after)) throw invalid();
  }
  if (limit === undefined) return { after, limit: 50 };
  if (typeof limit !== "string" || !/^[1-9]\d{0,2}$/.test(limit)) throw invalid();
  const size = Number(limit);
  if (size > 100) throw invalid();
  return { after, limit: size };
}

function entryResponse(entry: WalletLedgerEntry) {
  return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
    money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion, createdAt: entry.createdAt.toISOString() };
}

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletQueriesController {
  constructor(@Inject(WALLET_READS) private readonly reads: WalletReads,
    @Inject(RECONCILE_WALLET) private readonly reconcile: Pick<ReconcileWallet, "execute">) {}

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor: unknown, @Query("limit") rawLimit: unknown) {
    const id = notFoundUnlessUuid(walletId, "wallet");
    const { after, limit } = pagination(cursor, rawLimit);
    const entries = await this.reads.ledger(id, after, limit + 1);
    if (entries === undefined) throw new HttpProblem(404, "NOT_FOUND", "wallet not found");
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return { entries: page.map(entryResponse),
      nextCursor: entries.length > limit && last !== undefined ? Buffer.from(String(last.walletVersion)).toString("base64url") : null };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param("walletId") walletId: string): Promise<ReconciliationResult> {
    const result = await this.reconcile.execute(notFoundUnlessUuid(walletId, "wallet"));
    if (result === undefined) throw new HttpProblem(404, "NOT_FOUND", "wallet not found");
    return result;
  }
}
