# Distributed Wagering Processor — regras do projeto

O enunciado completo está em `docs/CHALLENGE.md`. Ele é a especificação; este arquivo
diz COMO trabalhar nela. Decisões já tomadas estão em `docs/DECISOES.md`; a matriz
exigência → garantia → teste está em `docs/INVARIANTES.md`; o estado atual está em
`docs/PROGRESS.md` (leia ao iniciar qualquer sessão, atualize ao terminar).

## O que está sendo avaliado

Correção financeira, concorrência entre instâncias, idempotência persistente,
consistência saldo ⇔ ledger, processamento assíncrono com recuperação após crash.
Não é CRUD. Uma solução que passa nos testes sem garantir as propriedades vale ZERO.

## Eliminatórias — nunca, sob nenhum pretexto

- `number`, `parseFloat`, `Number()`, `toFixed()` ou float para dinheiro. Dinheiro é
  `Money` (bigint em centavos no domínio, `NUMERIC(20,2)` no banco, string decimal nos contratos).
- Idempotência em memória (Map, cache, LRU). A fonte da verdade é o PostgreSQL.
- Publicar evento antes do commit. Eventos só saem pela outbox.
- UPDATE/DELETE em `wallet_ledger_entries`.
- Lock global (advisory lock fixo, mutex de processo, fila única). A unidade de lock é a `walletId`.
- `read → calculate → update` sem `SELECT … FOR UPDATE` e sem update condicionado.
- Mockar PostgreSQL ou SQS em `test/integration`, `test/concurrency` ou `test/acceptance`.
- Afrouxar constraint, trigger, CHECK ou teste para "fazer passar".

## Quando um teste falha

1. A hipótese padrão é: **o código de produção está errado.** Corrija o código.
2. Se você acredita que o TESTE contradiz `docs/CHALLENGE.md`, PARE e explique, citando
   a seção. Não edite o teste por conta própria.
3. Teste de concorrência intermitente é bug real até prova em contrário. Proibido
   resolver com `sleep`, retry extra, `--timeout` maior ou serialização no teste.
   Encontre a causa (lock, isolamento, pool, ordem de locks) e explique-a.
4. Arquivos em `test/acceptance/**` e `docs/CHALLENGE.md` são congelados (hook bloqueia).

## Arquitetura (hexagonal, dependências apontam para dentro)

```
src/domain/          TS puro. Zero import de @nestjs/*, @mikro-orm/*, pg, aws-sdk.
  money.ts  wallet.ts  wager-transaction.ts  ledger-entry.ts  inbox-message.ts
  outbox-message.ts  events/*.ts  failure-codes.ts  errors.ts
src/application/     use cases + ports (interfaces). Sem framework.
  open-wallet  process-wager-transaction  resolve-pending-references
  reconcile-wallet  ports/{unit-of-work, clock, id-generator, fault-injector, metrics}
src/infrastructure/  MikroORM (EntitySchema + mappers ↔ rehydrate), repositórios,
  SQS consumer, outbox publisher, workers, logging (pino), métricas (prom-client)
src/interface/http/  controllers Nest, validação de DTO, mapeamento erro → HTTP
migrations/          versionadas, com up E down, testadas em round-trip
test/unit | integration | concurrency | acceptance | support
```

- Entidades de domínio NÃO são entidades do ORM. Persistência usa registros + mappers;
  reidratação sempre por `X.rehydrate(state)` (não revalida transições).
- Construtores `private`; criação por `create`/`open`/`from`/`enqueue`/`receive`.
- HTTP e SQS chamam o MESMO use case `ProcessWagerTransaction`.

## Contrato transacional do caminho crítico (não negociável)

Um use case = uma transação SQL curta (`em.transactional`). Dentro dela, nesta ordem:

1. `SELECT … FROM wallets WHERE id = $1 FOR UPDATE` (lock POR WALLET).
2. Inbox (se veio da fila): `INSERT … ON CONFLICT DO NOTHING`; se já existia → replay.
3. Busca por `idempotency_key`: existe + mesmo hash → replay com o resultado ORIGINAL
   (`result_balance_amount`); existe + hash diferente → conflito.
4. Regras de negócio no domínio; `INSERT` transação (o ledger tem FK para ela);
   `UPDATE wallets … WHERE id=$1 AND version=$v AND balance_amount >= $x`
   (condicionado; 0 linhas = erro de programação, pois o lock já foi tomado);
   `INSERT` ledger.
5. `INSERT` outbox (eventos do mesmo commit).
6. COMMIT. Só depois: resposta HTTP / `DeleteMessage` no SQS.

- Ordem de locks global: **wallet → transações**. Nunca o contrário (worker incluso).
- NUNCA fazer I/O de rede (SQS, HTTP) com transação aberta.
- `23505` em `idempotency_key` (corrida perdida) ⇒ rollback e releitura ⇒ replay/conflito.
- Classificação de erro: negócio (terminal, persiste REJECTED, ack) · transitório
  (rollback, retry com backoff) · permanente (DLQ). Ver `docs/DECISOES.md`.

## Schema

`reference/sql/001_schema.sql` é o gabarito verificado em Postgres 16
(`reference/verify-schema.ts` prova cada ataque). A migration real deve reproduzi-lo
integralmente: CHECKs, UNIQUEs parciais, FKs compostas, triggers append-only e os
constraint triggers DIFERIDOS wallet ⇔ ledger. Mudou o schema? Atualize o gabarito,
rode `verify-schema.ts` e a matriz de invariantes.

## Testes

- Todo teste de integração/concorrência termina com `assertGlobalInvariants(db)`
  (consultas de `reference/sql/invariants.sql`; todas devem voltar vazias).
- Concorrência real: conexões distintas, pool ≥ paralelismo, barreira de largada,
  e prova de que houve sobreposição (não basta passar; tem que ter havido disputa).
- Multi-instância: processos reais via `Bun.spawn`, nunca "instâncias" no mesmo processo.
- Crash: `FaultInjector` com checkpoints nomeados (`after-commit-before-ack`,
  `after-publish-before-mark`, …) ativado só por env em teste; o processo se mata com SIGKILL.
- Proibido: `.skip`, `.only`, `.todo`, `expect(true)`, asserção só de status HTTP
  sem conferir banco.
- TDD: escreva o teste, mostre-o VERMELHO, implemente, mostre-o VERDE.

## Comandos

```
docker compose up -d --wait          # postgres + localstack prontos
bun run migration:up | migration:down
bun run typecheck                    # tsc --noEmit, strict
bun run lint
bun test test/unit
bun run test:integration             # containers reais
bun run test:concurrency
bun run test:all
```

## Definição de pronto (cada tarefa)

typecheck + lint + testes da fase verdes; invariantes vazias; `docs/PROGRESS.md`
atualizado; commit pequeno com mensagem que diga a garantia entregue. Para garantias
críticas, `/prove-red` mostrou que o teste fica vermelho sem a proteção.

## Estilo

TypeScript strict, sem `any` fora de fronteiras de I/O. Erros de domínio tipados.
Logs JSON com `correlationId, messageId, transactionId, walletId, providerId` —
nunca payload financeiro completo. Explique decisões não óbvias em `docs/DECISOES.md`,
não em comentários longos.
