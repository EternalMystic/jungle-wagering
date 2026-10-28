FASE 03 — Migration real + domínio (TDD).
Porte reference/sql/001_schema.sql para a migration inicial do MikroORM (up e down
idênticos ao gabarito, incluindo constraint triggers diferidos) e teste o round-trip
up/down/up. Depois o domínio em src/domain com TDD (teste vermelho → implementação →
verde): Money (bigint em centavos, regex de DECISOES.md D2, tabela de entradas
inválidas, conflito de moeda), Wallet, WagerTransaction (transições explícitas,
terminais imutáveis), WalletLedgerEntry (aritmética validada), InboxMessage,
OutboxMessage (backoff), IntegrationEvent abstrato + 4 subclasses, failure codes (D6),
hash canônico do payload (D4). Domínio sem import de framework.
