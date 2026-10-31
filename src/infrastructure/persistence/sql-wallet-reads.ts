import type { ReconciliationResult, WalletReads } from "../../application/ports/wallet-reads";
import { WalletLedgerEntry, type LedgerDirection } from "../../domain/ledger-entry";
import type { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";
import { toDate } from "./records";
import { Money } from "../../domain/money";

interface LedgerRecord {
  id: string; wallet_id: string; transaction_id: string; currency: string; direction: LedgerDirection;
  amount: string; balance_before: string; balance_after: string; wallet_version: string | number; created_at: string | Date;
}

function integer(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("unsafe database count or version");
  return n;
}

export class SqlWalletReads implements WalletReads {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  ledger(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[] | undefined> {
    return this.uow.withSql(async (sql) => {
      const found = await sql.query<{ id: string }>("SELECT id FROM wallets WHERE id = ?", [walletId]);
      if (found.rows.length === 0) return undefined;
      const { rows } = await sql.query<LedgerRecord>(
        "SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > ? ORDER BY wallet_version ASC LIMIT ?",
        [walletId, afterVersion, limit],
      );
      const out = [] as WalletLedgerEntry[];
      for (const r of rows) {
        out.push(WalletLedgerEntry.rehydrate({ id: r.id, walletId: r.wallet_id, transactionId: r.transaction_id,
        direction: r.direction, money: Money.from({ amount: r.amount, currency: r.currency }),
        balanceBefore: Money.from({ amount: r.balance_before, currency: r.currency }),
        balanceAfter: Money.from({ amount: r.balance_after, currency: r.currency }),
        walletVersion: integer(r.wallet_version), createdAt: toDate(r.created_at) }));
      }
      return out;
    });
  }

  // Deixar num SELECT só, senão dá para comparar saldos de commits diferentes.
  reconciliation(walletId: string): Promise<ReconciliationResult | undefined> {
    return this.uow.withSql(async (sql) => {
      const { rows } = await sql.query<{ id: string; currency: string; stored: string; calculated: string; difference: string; consistent: boolean; checked: string }>(
        `SELECT w.id, w.currency, w.balance_amount::text AS stored, l.calculated::text,
                (w.balance_amount - l.calculated)::text AS difference,
                w.balance_amount = l.calculated AS consistent, l.checked::text
         FROM wallets w CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0.00) AS calculated,
                  COUNT(*) AS checked FROM wallet_ledger_entries WHERE wallet_id = w.id
         ) l WHERE w.id = ?`, [walletId],
      );
      const r = rows[0];
      if (r === undefined) return undefined;
      return { walletId: r.id, storedBalance: { amount: r.stored, currency: r.currency },
        calculatedBalance: { amount: r.calculated, currency: r.currency }, difference: { amount: r.difference, currency: r.currency },
        consistent: r.consistent, checkedEntries: integer(r.checked) };
    });
  }
}
