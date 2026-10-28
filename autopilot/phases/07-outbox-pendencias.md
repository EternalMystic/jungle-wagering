FASE 07 — Outbox publisher + worker de pendências.
Publisher conforme D10 (lease + SKIP LOCKED, sem transação aberta durante I/O, backoff,
métrica de lag) e worker de PENDING_REFERENCE conforme D8 (backoff, TTL, resolução
ansiosa no mesmo commit da referência, ordem de locks wallet → transações). Faça passar
TODOS os testes de test/concurrency. Depois rode /prove-red para as linhas 11, 12, 14,
15 e 17 da matriz e registre em docs/PROGRESS.md.
