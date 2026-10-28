# Decisões técnicas (semente do ARCHITECTURE.md)

Cada item: decisão · por quê · alternativa descartada. O README exige que "qualquer
interpretação adicional" seja documentada — as marcadas com **[interpretação]** são
pontos em que o enunciado é ambíguo e a banca provavelmente vai perguntar.

---

## D1. ORM: MikroORM (preferencial)

- `em.transactional()` dá a fronteira de Unit of Work explícita; `LockMode.PESSIMISTIC_WRITE`
  gera `FOR UPDATE`; `em.fork()` por requisição/mensagem isola o Identity Map.
- Domínio NÃO é entidade do ORM: `EntitySchema` + mappers na infraestrutura; leitura
  chama `Wallet.rehydrate(state)`. Mantém o domínio sem decorators (exigência §6.1).
- Trechos críticos (update condicionado, `ON CONFLICT`, `SKIP LOCKED`) em SQL explícito
  via `em.execute()` **dentro** da mesma transação — legibilidade e controle do plano.
- Migrations: `@mikro-orm/migrations`, cada uma com `up` e `down`, round-trip testado.
- Descartado: TypeORM (aceito, mas sem UoW explícito); Prisma (fora do escopo).

## D2. Money

- Domínio: `bigint` em centavos + `currency`. Imutável; toda operação devolve nova instância.
- Contrato: string com **exatamente 2 casas** — regex `^(0|[1-9]\d{0,17})\.\d{2}$`.
  Rejeita `NaN`, `Infinity`, `1e3`, `""`, `" 1.00"`, `"1.0"`, `"1.000"`, `"-1.00"`, `"01.00"`.
  **[interpretação]** "1" e "1.5" também são rejeitados (o README diz escala fixa de 2).
- Nunca arredonda: entrada com mais de 2 casas é ERRO, não arredondamento. Importante
  porque `'10.005'::numeric(20,2)` vira `10.01` em silêncio no Postgres (provado em
  `reference/verify-schema.ts`) — `Money.from` é o portão.
- Banco: `NUMERIC(20,2)`; o driver devolve string; o mapper chama `Money.from`.
- `negate()` existe para cálculo interno (ex.: `difference` da reconciliação); valores
  negativos são rejeitados apenas nos contratos de entrada.
- Moedas diferentes → `CurrencyMismatchError` (domínio). Desafio assume BRL, modelo multi-moeda.
- Descartado: `decimal.js` (desnecessário com escala fixa 2; bigint é exato e nativo).

## D3. Concorrência: lock pessimista por wallet + update condicionado + constraints

- `SELECT … FOR UPDATE` na linha da wallet serializa só aquela wallet; wallets diferentes
  seguem em paralelo. Hot wallet: fila de espera no Postgres, sem tempestade de retries.
- Defesa em profundidade: `UPDATE … WHERE version = $v AND balance_amount >= $x`
  e `CHECK (balance_amount >= 0)`; constraint triggers diferidos garantem que toda
  mudança de saldo tem lançamento e vice-versa (ver `reference/sql/001_schema.sql`).
- Prova: o anti-padrão read→calculate→update sem lock é RECUSADO pelo banco
  (`uq_ledger_wallet_version`) — `verify-schema.ts`, seção "Sabotagem".
- Ordem de locks: **wallet → transações**, inclusive no worker de pendências
  (que reivindica com `SKIP LOCKED`, solta, e depois processa cada item travando a wallet primeiro).
- `lock_timeout` por transação (ex.: 5s) → erro TRANSITÓRIO (retry), métrica `lock_conflicts_total`.
- Isolamento: READ COMMITTED basta porque a decisão é tomada sob o row lock.
- Descartado: otimista puro (retry storm em hot wallet), SERIALIZABLE (aborts e retries
  em massa sem ganho, já que o lock é explícito), advisory lock global (eliminatório).

## D4. Idempotência em três camadas, todas persistentes

| Camada | Chave | Onde | Para quê |
|---|---|---|---|
| HTTP/negócio | `idempotency_key` | `UNIQUE` em `wager_transactions` | replay e conflito |
| Provedor | `(provider_id, external_transaction_id)` | `UNIQUE` | mesma operação com key diferente |
| Fila | `(consumer_name, message_id)` | PK de `inbox_messages` | redelivery do SQS |

- `payloadHash` = SHA-256 hex do JSON canônico (chaves ordenadas recursivamente, sem
  espaços, UTF-8) dos campos de negócio: `providerId, externalTransactionId, playerId,
  walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`
  (omitido quando ausente). Fora do hash: header, `idempotencyKey`, `messageId`, `occurredAt`.
- Consequência desejada: a mesma operação chegando por HTTP e depois por SQS é replay.
- Replay devolve o resultado ORIGINAL: `result_balance_amount` é congelado na transação.
- **[interpretação]** Replay de algo ainda `PENDING_REFERENCE` devolve o estado atual
  (202); se entretanto foi resolvido, devolve o resultado terminal.
- `(provider_id, external_transaction_id)` igual com key diferente → `409 IDEMPOTENCY_CONFLICT`.

## D5. Mapeamento HTTP (consistente em todos os endpoints)

| Situação | Status | Corpo (`error.code` / campos) | Reenviar? |
|---|---|---|---|
| Aplicada | 200 | `status: PROCESSED`, `balance`, `idempotentReplay` | não precisa |
| Aceita, aguardando referência | 202 | `status: PENDING_REFERENCE` | não; consultar GET |
| Rejeição de negócio | 422 | `status: REJECTED`, `failureCode` | só corrigindo a causa |
| Payload inválido / header ausente | 400 | `INVALID_PAYLOAD`, `IDEMPOTENCY_KEY_REQUIRED` | só corrigindo |
| Conflito de idempotência | 409 | `IDEMPOTENCY_CONFLICT` | nunca com a mesma key |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` | não |
| Recurso inexistente (GET) | 404 | `NOT_FOUND` | — |
| Falha transitória de infra | 503 + `Retry-After` | `TEMPORARILY_UNAVAILABLE` | sim, mesma key |
| Erro inesperado | 500 | `INTERNAL_ERROR` | sim, mesma key |

Todo erro tem `{ error: { code, message, retryable } }`. Replay devolve o MESMO status do original.

## D6. Taxonomia de `failureCode` (estável, legível por máquina)

`INSUFFICIENT_FUNDS` · `REVERSAL_INSUFFICIENT_FUNDS` (distinto, exigido §7.9) ·
`CURRENCY_MISMATCH` · `WALLET_NOT_FOUND` · `WALLET_PLAYER_MISMATCH` ·
`REFERENCE_NOT_FOUND` (TTL esgotado) · `REFERENCE_KIND_NOT_REVERSIBLE` ·
`REFERENCE_SCOPE_MISMATCH` (provider/player/wallet/moeda/rodada) ·
`REFERENCE_AMOUNT_MISMATCH` · `REFERENCE_NOT_PROCESSED` · `REFERENCE_ALREADY_REVERSED` ·
`OPENING_NOT_ALLOWED`. Infra (`FAILED`): `PERMANENT_INFRA_ERROR`.

**[interpretação]** `WALLET_NOT_FOUND` é a única rejeição não persistida (não há agregado
dono para a FK); responde 422 e, na fila, faz ack. Documentar.

## D7. Reversões

- **[interpretação]** Uma transação é revertida no máximo UMA vez por QUALQUER reversão
  (índice único parcial em `reference_transaction_id`). O README diz "pelo mesmo tipo";
  a leitura literal permitiria REFUND + ROLLBACK da mesma BET = crédito duplicado,
  que é eliminatório. ROLLBACK de um REFUND continua possível (referencia o REFUND).
- ROLLBACK inverte a direção da referência (BET→CREDIT, WIN/REFUND→DEBIT).
- Reversão que deixaria saldo negativo → `REJECTED / REVERSAL_INSUFFICIENT_FUNDS`, auditável.
- `LOSS`: não mexe em saldo, não gera lançamento, gera `WagerTransactionProcessed`;
  **[interpretação]** aceita `amount >= 0`.
- `WIN` com referência: valida escopo; sem referência: permitido.

## D8. Referências fora de ordem

- Referência ausente → `PENDING_REFERENCE` + evento `WagerTransactionPendingReference`;
  inbox marcada; ack (o trabalho agora é do banco, não da fila).
- Worker agendado: reivindica com `FOR UPDATE SKIP LOCKED` lotes vencidos,
  backoff `min(5s · 2^n, 5min)`, máximo 8 tentativas (5+10+20+40+80+160+300+300 = 915 s ≈ 15 min) **[escolha justificável:
  provedores reenviam a BET em minutos; além disso é incidente, não atraso]**.
- Resolução ansiosa: ao processar uma BET/WIN/REFUND, no MESMO commit, resolve pendências
  que a referenciam (ordem de lock preservada: wallet já travada → linhas pendentes).
- Esgotado: `REJECTED / REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

## D9. SQS

- `wager-transactions.fifo` com `RedrivePolicy maxReceiveCount=5` → `wager-transactions-dlq.fifo`.
  `MessageGroupId = walletId` (ordem por wallet como OTIMIZAÇÃO), `MessageDeduplicationId = messageId`.
- Long polling 20s, visibility 30s com heartbeat (`ChangeMessageVisibility`) em processamentos longos.
- Negócio (inclui REJECTED e PENDING_REFERENCE): commit → `DeleteMessage`.
- Transitório (PG fora, lock timeout, SQS throttling): rollback, `ChangeMessageVisibility`
  com backoff por `ApproximateReceiveCount`; após 5 recebimentos a redrive manda à DLQ.
- Permanente (JSON inválido, schema inválido, `messageId` repetido com hash diferente):
  envia à DLQ com atributo de motivo e apaga da fila (não bloqueia o grupo FIFO).
- SIGTERM: para de buscar, espera as em andamento (com prazo), devolve as restantes com
  `ChangeMessageVisibility 0`; `app.enableShutdownHooks()`.

## D10. Outbox

- Mesma transação do efeito. Publisher em cada instância:
  `UPDATE outbox SET locked_by=$me, locked_until=now()+30s WHERE id IN (SELECT id … WHERE
  published_at IS NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR
  locked_until < now()) ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING *`
  — reivindicação curta, sem segurar transação durante a chamada ao SQS (lease).
- Publica em `wallet-events.fifo` (fila extra, documentar): `MessageGroupId = aggregateId`,
  `MessageDeduplicationId = eventId`. Depois: `UPDATE … SET published_at WHERE id AND locked_by=$me`.
- Crash entre publicar e marcar → lease expira → republica → consumidor deduplica por `eventId`
  (at-least-once honesto; dedupe do FIFO é só otimização de 5 min).
- Falha: `scheduleRetry` (attempts++, backoff), `last_error`.
- Métrica `outbox_lag_seconds = now() − min(occurred_at) WHERE published_at IS NULL`.

## D11. Autenticação

**Não implementada** (não pontua, §2). `AuthGuard` no-op atrás de um `ProviderIdentityPort`;
desenho proposto no ARCHITECTURE.md: Keycloak, client credentials por provedor, claim
`provider_id` comparada ao `providerId` do corpo. Health e fila fora do escopo.

## D12. Observabilidade

pino (JSON) + `AsyncLocalStorage` para `correlationId/messageId/transactionId/walletId/providerId`;
redact de `money`/payload. prom-client em `/metrics`: `wager_transactions_total{status,kind}`,
`idempotent_replays_total{channel}`, `inbox_duplicates_total`, `sqs_retries_total`,
`sqs_dlq_total{reason}`, `lock_conflicts_total`, `outbox_lag_seconds`,
`wager_processing_seconds` (histograma), `reconciliation_divergences_total`.
`/health/live` (processo) e `/health/ready` (`SELECT 1` + `GetQueueUrl`), ambos sem auth.

## D13. Emulador SQS: MiniStack [autopilot]

- `ministackorg/ministack` (MIT, porta 4566, sem token) no `docker-compose.yml` e no CI.
  A imagem atual do LocalStack exige conta/token; o MiniStack não.
- Condição: `test/integration/sqs-emulator.test.ts` prova, contra o emulador real, FIFO
  (recusa envio sem `MessageGroupId`, ordem por grupo), bloqueio do grupo com mensagem em
  voo, `MessageDeduplicationId` e `RedrivePolicy` (entregue exatamente `maxReceiveCount`
  vezes, depois aparece na DLQ). Se esse arquivo ficar vermelho, troca-se para
  `localstack/localstack` com `LOCALSTACK_AUTH_TOKEN` do ambiente (registrar aqui e no README).
- Mesmo com a redrive funcionando, o envio EXPLÍCITO à DLQ para erros permanentes (D9)
  continua: não dependemos de esgotar 5 recebimentos para tirar um veneno do grupo FIFO.
- Healthcheck: a imagem pode não ter curl; o compose testa a porta com python/curl/wget.

## D14. Infra local e scripts [autopilot]

- Postgres do compose publicado na **55432** do host (a 5432 costuma estar ocupada por
  outro Postgres da máquina — ocorreu no ambiente do autopilot). `DATABASE_URL` sobrescreve.
- `verify:schema` roda `scripts/verify-schema.ts`, que só injeta o `DATABASE_URL` do
  projeto e importa `reference/verify-schema.ts` intacto. Motivo: o default do gabarito é
  `localhost:5432` e apontaria para um Postgres alheio; `reference/` é congelado.
- Migrations: o CLI do MikroORM não é usado (depende de ts-node/descoberta de config);
  `scripts/migrate.ts` chama o `Migrator` programaticamente, com `migrationsList` explícita
  (`migrations/index.ts`), `transactional` e `allOrNothing`. Round-trip testado em banco
  descartável em `test/integration/stack.test.ts`.

## D16. Contrato dos testes de aceitação [autopilot]

- Caixa-preta: a aplicação sobe como PROCESSO (`bun run src/main.ts`) e é acessada por
  HTTP; o banco é preparado pelo comando de produção (`scripts/migrate.ts up`) num
  template (`wagering_tpl_<hash de migrations/>`) e cada arquivo ganha
  `CREATE DATABASE … TEMPLATE`. Os testes só dependem de `src/` para ler config e criar filas.
- Ambiente que a aplicação PRECISA respeitar: `DATABASE_URL`, `PORT`, `SQS_WAGER_QUEUE`,
  `SQS_WAGER_DLQ`, `SQS_WALLET_EVENTS_QUEUE` (filas exclusivas por arquivo de teste) e
  **`DB_POOL_MAX`** (tamanho do pool do processo; os testes passam 60). Sem isso, a BET
  50× não consegue ter as 50 requisições dentro do banco ao mesmo tempo e o teste falha.
- Prova de paralelismo (`test/support/concurrency.ts#contend`): o teste segura o recurso
  disputado (linha da wallet `FOR UPDATE`, ou a chave única player+moeda com INSERT não
  confirmado), dispara as requisições atrás de uma barreira e só solta quando
  `pg_stat_activity` mostra N backends em `wait_event_type = 'Lock'`. Segura no máximo 3 s;
  portanto o `lock_timeout` da aplicação (D3) tem de ser **> 3 s** (D3 sugere 5 s).
- `POST /wallets` bem-sucedido → **201** com `{id, playerId, balance, version}`.
- Resposta de rejeição (422) tem o MESMO formato da de sucesso: `transactionId, status:
  "REJECTED", failureCode, balance, idempotentReplay`. O replay devolve o mesmo status (D5).
- Transação REJECTED congela em `result_balance_amount` o saldo observado sob o lock
  (no cenário §8 o perdedor registra 20.00, não 100.00) — é o "saldo observado naquele
  momento" de §7.7.
- Nomes de constraint do gabarito (`uq_tx_idempotency_key`, `uq_tx_provider_external`,
  `uq_ledger_one_entry_per_tx_wallet`, `uq_ledger_wallet_version`, `uq_tx_single_reversal`,
  `uq_wallet_player_currency`) são contrato: os testes de schema conferem o nome, não só o
  SQLSTATE (para não passar por acidente com outro erro).
- Eventos na outbox são localizados por `payload -> 'data' ->> 'transactionId'` (mesma
  convenção de `reference/sql/invariants.sql` I6/I7).

## D17. Régua endurecida na revisão 02r [autopilot]

- Ataques de CHECK conferem ONDE a recusa acontece (`at: statement | commit`) e QUAL
  constraint (`pg_get_constraintdef` casando com a regra). Logo, a migration real precisa:
  não-negatividade como CHECK de coluna imediato em `wallets.balance_amount` e
  `wallet_ledger_entries.balance_after`; coerência wallet ⇔ ledger e regras de `version`
  como constraint triggers DIFERIDOS (como no gabarito).
- Mesmo `(providerId, externalTransactionId)` com `Idempotency-Key` diferente, inclusive em
  paralelo → exatamente um efeito e **409 `IDEMPOTENCY_CONFLICT`** para os demais (D4), via
  `uq_tx_provider_external` + tratamento do 23505 (rollback, releitura).
- Replay tardio (depois de o saldo mudar) devolve o saldo ORIGINAL — testado na aceitação.
- O template de testes é indexado pelo hash de `migrations/**`, `scripts/migrate.ts`,
  `src/infrastructure/persistence/**` e lockfile; schema decidido fora disso não é visto.
- Detalhes e achados: `docs/REVISAO-ACEITACAO.md`.

## D15. Readiness [autopilot]

- `/health/ready` roda os probes em paralelo, cada um com prazo (`READINESS_TIMEOUT_MS`,
  padrão 2 s); qualquer falha/timeout → 503 `{status:"unavailable", checks:{…:"down"}}`.
  Postgres: `select 1` num fork do EM; SQS: `GetQueueUrl` da fila de entrada (prova que a
  topologia existe, não só que a porta está aberta). `/health/live` não toca em dependências.

## D18. Migration inicial e modelagem do domínio (fase 03) [autopilot]

- **Migration**: o schema entra na `Migration20261028000000_initial` (era um spike vazio,
  nunca usado fora de bancos descartáveis), com `up` = `reference/sql/001_schema.sql` e
  `down` = `001_schema.down.sql`, um `addSql` por statement; o BEGIN/COMMIT vem do
  Migrator (`transactional`). `disableForeignKeys: false` fixado na config: `true` faria
  `session_replication_role = replica`, que desliga triggers (as garantias do schema).
  Fidelidade provada em `test/integration/migrations.test.ts`: o catálogo (colunas,
  constraints com deferrable/deferred, índices, triggers e `prosrc` das funções) do banco
  migrado é IGUAL ao do gabarito aplicado cru; o down não deixa resíduo.
- **Money**: `toString()` devolve só o valor ("975.00"); `toJSON()` devolve `MoneyProps`.
  `equals` com moedas diferentes devolve `false`; `add/subtract/isLessThan/
  isGreaterThanOrEqual` lançam `CurrencyMismatchError`. Resultado além de NUMERIC(20,2)
  (|valor| > 999999999999999999.99) é `InvalidMoneyError` — nunca estouro silencioso.
  `fromCents` existe para reconstrução interna; contratos usam `from` (regex D2).
- **WagerTransaction**: `create` recusa `OPENING` (interno, só via `createOpening`, provider
  `internal`, key `internal:opening-<walletId>`). Transições = tabela do trigger
  `fn_tx_guard`; PENDING_REFERENCE → PENDING_REFERENCE é `scheduleReferenceRetry` (conta a
  tentativa). `reject` exige `resultBalance` (saldo observado, na moeda da WALLET — pode
  diferir em CURRENCY_MISMATCH) e recusa `WALLET_NOT_FOUND` (não persistível, D6) e códigos
  de infra; `fail` só aceita códigos de infra. `markProcessed` exige saldo na moeda da
  transação e, para REFUND/ROLLBACK, a referência interna (espelha os CHECKs do schema).
- **Wallet**: `open` devolve `{ wallet, openingEntry }` (CREDIT v1 de 0.00 quando há saldo
  inicial; nenhum lançamento com 0.00 — como o trigger de abertura). `credit/debit`
  devolvem o lançamento e sobem `version` em 1; o lançamento é validado ANTES de o agregado
  mudar (falha não deixa meio-estado). `debit` sem saldo lança `InsufficientFundsError`;
  o use case consulta `canDebit` antes e escolhe `INSUFFICIENT_FUNDS` ×
  `REVERSAL_INSUFFICIENT_FUNDS`.
- **Eventos**: `aggregateId = walletId` para TODOS (inclusive os de transação): todos os
  eventos de uma wallet caem no mesmo `MessageGroupId` e chegam ordenados. Campos ausentes
  em `data` são `null` (schema JSON estável); `data` é congelado. `WalletBalanceChanged.from`
  exige que o lançamento seja o último movimento da wallet.
- **Outbox backoff**: `min(1 s · 2^(attempts−1), 5 min)`, sem limite de tentativas — evento
  confirmado nunca é descartado; atraso aparece em `outbox_lag_seconds`. Lease/locks são
  infraestrutura (SQL, D10), não domínio.
- **Kinds/status/direção** são objeto `as const` + união de literais, não `enum` do TS: o
  enum é nominal e recusaria `"BET"`/`"DEBIT"` vindos do banco/JSON sem cast nas
  fronteiras (o typecheck do portão da fase 03 pegou isso). Uso igual: `WagerTransactionKind.Bet`.
- **Hash (D4)**: `canonicalJson` recusa números/bigint/Date/Map (só string, boolean, null,
  arrays e objetos planos); chaves ordenadas pela ordem de code unit UTF-16; `undefined`
  omitido. O DTO deve normalizar `null` → ausente antes de montar o `WagerPayload`.
  Domínio usa `node:crypto` (biblioteca padrão, não framework).
