# Progresso (passagem de bastão entre sessões)

Atualize ao fim de cada sessão: o que ficou pronto, o que está vermelho e por quê,
próxima ação. Curto. A sessão seguinte lê isto primeiro.

## Estado

- Fase atual: 01 — spike do stack (código escrito; portão a confirmar pelo orquestrador)
- Portões verdes: —
- Sabotagens comprovadas (`/prove-red`): —

## Fase 01 — feito

- Bun + TS strict + NestJS 11 + MikroORM 6 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`).
- `docker-compose.yml`: postgres:16 (host 55432) + MiniStack (4566), ambos com healthcheck.
- `sqs:setup` (`scripts/sqs-setup.ts` → `src/infrastructure/sqs/setup-queues.ts`):
  `wager-transactions.fifo` com redrive maxReceiveCount=5 → `wager-transactions-dlq.fifo`;
  `wallet-events.fifo`. Reexecutável.
- Migrator programático (`scripts/migrate.ts`), migration inicial vazia, lista explícita.
- `GET /health/live` e `GET /health/ready` (SELECT 1 + GetQueueUrl, 503 se cair).
- Testes: `test/unit/app-config.test.ts`; `test/integration/sqs-emulator.test.ts` (prova
  FIFO/grupo/dedup/redrive no emulador real); `test/integration/stack.test.ts` (Postgres 16,
  round-trip de migrations em banco descartável, health 200/503 com Nest real).
- CI ajustado para MiniStack. Decisões D13–D15 em `docs/DECISOES.md`.

## Em aberto

- 2026-10-28 (sessão autopilot fase 01): o modo de permissão desta execução bloqueou
  `docker compose`, `curl` e até `bun` (só leitura de arquivos passava). Nenhum comando do
  portão pôde ser executado pelo agente; o código foi escrito sem execução. Se o portão
  falhar, os primeiros suspeitos são: comportamento do MiniStack na redrive/bloqueio de
  grupo (ver D13 — trocar para LocalStack só se o emulador de fato não suportar) e o
  healthcheck do MiniStack no compose/CI.

## Próxima ação

- Orquestrador roda o portão da fase 01. Verde → fase 02 (testes de aceitação).
