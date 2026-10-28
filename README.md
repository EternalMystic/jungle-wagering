# Distributed Wagering Processor

Especificação: `docs/CHALLENGE.md`. Decisões: `docs/DECISOES.md`. Estado: `docs/PROGRESS.md`.

## Rodando localmente

Requisitos: Bun 1.x e Docker.

```bash
bun install
docker compose up -d --wait   # postgres:16 (host 55432) + MiniStack SQS (4566)
bun run sqs:setup             # wager-transactions.fifo (+DLQ, maxReceiveCount=5), wallet-events.fifo
bun run migration:up
bun run start                 # GET /health/live, GET /health/ready na porta 3000
```

Variáveis: `DATABASE_URL`, `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `PORT`, `READINESS_TIMEOUT_MS` (defaults apontam para o compose).

## Emulador SQS

MiniStack (`ministackorg/ministack`, sem token). `test/integration/sqs-emulator.test.ts`
prova FIFO, `MessageGroupId`, `MessageDeduplicationId` e `RedrivePolicy` nele (D13).

## Testes

```bash
bun run typecheck && bun run lint
bun run test:unit
bun run test:integration      # Postgres e SQS reais
bun run test:all
```
