FASE 01 — Spike do stack.
Monte o esqueleto mínimo: Bun 1.x, TypeScript strict, NestJS, MikroORM com
@mikro-orm/postgresql e @mikro-orm/migrations, docker-compose.yml com postgres:16 e um
emulador de SQS com healthchecks. Emulador: teste primeiro o MiniStack
(ministackorg/ministack, porta 4566, sem token) e PROVE com um teste que FIFO,
MessageGroupId, MessageDeduplicationId e RedrivePolicy (maxReceiveCount) funcionam. Se
não funcionarem, use localstack/localstack lendo LOCALSTACK_AUTH_TOKEN do ambiente e
registre isso em docs/DECISOES.md e no README.
Script sqs:setup cria wager-transactions.fifo, wager-transactions-dlq.fifo (redrive
maxReceiveCount=5) e wallet-events.fifo. Scripts em package.json (os mesmos que
.github/workflows/ci.yml chama): typecheck, lint, sqs:setup, migration:up,
migration:down, verify:schema (bun run reference/verify-schema.ts, com pg como devDependency),
test:unit, test:acceptance, test:integration, test:concurrency, test:all.
Implemente só GET /health/live e GET /health/ready (SELECT 1 + GetQueueUrl).
Se o CLI de migrations do MikroORM falhar sob Bun, rode o Migrator programaticamente.
Crie uma migration inicial vazia e um teste em test/integration que fala com o
Postgres e o SQS REAIS. Ajuste .github/workflows/ci.yml ao emulador escolhido.
