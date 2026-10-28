-- =============================================================================
-- INVARIANTES GLOBAIS — rode ao final de TODO teste de integração/concorrência.
-- Cada query retorna as linhas que VIOLAM a regra. Resultado esperado: vazio.
-- Use via helper `assertGlobalInvariants(db)` em test/support/.
-- =============================================================================

-- I1. wallet.balance == saldo reconstruído pelo ledger (invariante final do README)
SELECT w.id, w.balance_amount AS stored,
       COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS calculated
  FROM wallets w
  LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
 GROUP BY w.id, w.balance_amount
HAVING w.balance_amount <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0);

-- I2. versão da wallet == 1 + nº de lançamentos não-OPENING (version só sobe quando o saldo muda)
SELECT w.id, w.version, COUNT(l.id) AS entries
  FROM wallets w
  LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
  LEFT JOIN wager_transactions t ON t.id = l.transaction_id
 GROUP BY w.id, w.version
HAVING w.version <> 1 + COUNT(l.id) FILTER (WHERE t.kind <> 'OPENING');

-- I3. encadeamento: balance_before(n) == balance_after(n-1)
SELECT cur.wallet_id, cur.wallet_version
  FROM wallet_ledger_entries cur
  JOIN LATERAL (
    SELECT p.balance_after FROM wallet_ledger_entries p
     WHERE p.wallet_id = cur.wallet_id AND p.wallet_version < cur.wallet_version
     ORDER BY p.wallet_version DESC LIMIT 1
  ) prev ON TRUE
 WHERE prev.balance_after <> cur.balance_before;

-- I4. todo PROCESSED que mexe em saldo tem exatamente 1 lançamento; LOSS/REJECTED/FAILED/PENDING têm 0
SELECT t.id, t.kind, t.status, COUNT(l.id) AS entries
  FROM wager_transactions t
  LEFT JOIN wallet_ledger_entries l ON l.transaction_id = t.id
 GROUP BY t.id, t.kind, t.status
HAVING (t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND COUNT(l.id) <> 1)
    OR ((t.status <> 'PROCESSED' OR t.kind = 'LOSS') AND COUNT(l.id) <> 0);

-- I5. nenhuma referência revertida mais de uma vez
SELECT reference_transaction_id, COUNT(*)
  FROM wager_transactions
 WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
 GROUP BY reference_transaction_id
HAVING COUNT(*) > 1;

-- I6. todo PROCESSED/REJECTED tem evento na outbox (atomicidade tx ⇔ outbox)
SELECT t.id, t.status
  FROM wager_transactions t
 WHERE t.status IN ('PROCESSED','REJECTED') AND t.kind <> 'OPENING'
   AND NOT EXISTS (
     SELECT 1 FROM outbox_messages o
      WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text
        AND o.event_type IN ('WagerTransactionProcessed','WagerTransactionRejected'));

-- I7. todo lançamento tem WalletBalanceChanged correspondente
SELECT l.transaction_id
  FROM wallet_ledger_entries l
  JOIN wager_transactions t ON t.id = l.transaction_id
 WHERE t.kind <> 'OPENING'
   AND NOT EXISTS (
     SELECT 1 FROM outbox_messages o
      WHERE o.event_type = 'WalletBalanceChanged'
        AND o.payload -> 'data' ->> 'transactionId' = l.transaction_id::text);

-- I8. nenhum saldo negativo, em lugar nenhum (redundante com CHECK — é o ponto)
SELECT id FROM wallets WHERE balance_amount < 0
UNION ALL
SELECT id FROM wallet_ledger_entries WHERE balance_after < 0 OR balance_before < 0;
