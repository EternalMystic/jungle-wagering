FASE 09 — Observabilidade, reconciliação e consultas.
D12 completo (pino com AsyncLocalStorage e redact; prom-client em /metrics com as
métricas listadas), POST /wallets/:walletId/reconciliation (divergência logada,
contada em métrica e sinalizada, nunca corrigida), GET /wallets/:id/ledger com cursor
opaco (base64url de wallet_version) e os demais GETs da §9. AuthGuard no-op atrás de
ProviderIdentityPort (D11). Testes de integração para cada endpoint novo.
