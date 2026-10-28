-- Reverso exato de 001_schema.sql (migrations reversíveis são requisito).
BEGIN;
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
DROP FUNCTION IF EXISTS fn_ledger_entry_coherence();
DROP FUNCTION IF EXISTS fn_wallet_ledger_coherence();
DROP FUNCTION IF EXISTS fn_outbox_guard();
DROP FUNCTION IF EXISTS fn_tx_guard();
DROP FUNCTION IF EXISTS fn_ledger_append_only();
COMMIT;
