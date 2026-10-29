# Decisões técnicas (semente do ARCHITECTURE.md)

Cada item: decisão · por quê · alternativa descartada. O README exige que "qualquer
interpretação adicional" seja documentada — as marcadas com **[interpretação]** são
pontos em que o enunciado é ambíguo e a banca provavelmente vai perguntar.

## D24. Observabilidade, consultas e reconciliação (fase 09) [autopilot]

- Ledger: ordem crescente por `wallet_version`, cursor exclusivo `base64url` da versão
  decimal canônica (sem padding); padrão 50, intervalo 1–100. Busca `limit + 1` para
  só anunciar continuação quando existe outra linha. Cursor inválido/não canônico ou
  versão fora do intervalo inteiro seguro retorna 400; wallet ausente retorna 404.
  **[interpretação]** a paginação é estável por chave imutável, sem OFFSET: novos
  commits podem aparecer nas próximas páginas, sem repetir/pular versões já lidas.
  Uma abertura zero não tem entrada v1; a primeira movimentação aparece na versão 2.
- `ReconcileWallet` usa `WalletReads`; a implementação SQL lê saldo, soma assinada,
  contagem e diferença em **um SELECT**, no mesmo snapshot READ COMMITTED. Não trava
  wallet nem compara duas leituras de instantes diferentes. Soma/diferença usam
  NUMERIC exato do PostgreSQL e chegam como strings de escala 2 (`MoneyProps`), sem
  conversão monetária para number e sem cast limitador NUMERIC(20,2) no agregado.
  Isso também permite diagnosticar um ledger corrompido cuja soma exceda o teto do
  saldo. `difference = storedBalance - calculatedBalance`, inclusive negativa.
  Retorna 200 com `consistent: false`; incrementa métrica e loga erro com identificadores,
  nunca valores. Não escreve wallet, ledger, transação ou outbox para "consertar".
- D12: `JsonLogger` agora usa pino, ALS e redact; saneamento recursivo também cobre
  campos sensíveis aninhados e instâncias de Error. Middleware HTTP gera/normaliza
  correlationId, devolve `X-Correlation-Id` e preserva o contexto até o filtro/resposta.
  HTTP, SQS, publisher e resolução têm escopos assíncronos independentes. O logger
  Nest também emite JSON sanitizado, sem copiar mensagens/stacks arbitrários.
- `PrometheusMetrics` possui Registry por aplicação, sem labels de IDs/payloads.
  `wager_transactions_total{status,kind}` conta transições **confirmadas**, incluindo
  OPENING e resolução de pendências (PENDING_REFERENCE e terminal são transições
  distintas). A UoW acumula observações por tentativa e só as aplica após o commit;
  rollback/replay não contam nova decisão. Duplicatas de inbox também só contam após
  commit. Replays e latência são observados no adaptador compartilhado HTTP/SQS em
  torno do mesmo ProcessWagerTransaction; latência inclui erro/tentativas SQL.
- `sqs_retries_total` conta decisões de retry de mensagens; `sqs_dlq_total{reason}`
  conta envios explícitos bem-sucedidos à DLQ, antes do ack. A redrive automática do
  SQS continua uma garantia da fila: este contador não pretende observar entregas
  realizadas internamente pelo serviço. `lock_conflicts_total` conta 55P03/40001/40P01,
  inclusive causas embrulhadas. Lag é recalculado sobre a outbox confirmada em cada
  scrape, incluindo lease/backoff. Histograma e contadores são telemetria do processo
  e podem reiniciar/perder a última observação em crash; nunca substituem o ledger.
- D11: AuthGuard nos controllers financeiros delega a ProviderIdentityPort. O adapter
  NoopProviderIdentity retorna ausência de identidade e permite acesso, conforme §2;
  não simula validação de token. Adapter futuro com IdP externo (Keycloak, client
  credentials por provedor) devolve providerId verificado, comparado pelo guard ao
  providerId da rota/corpo. Health, metrics e SQS não passam pelo guard.
- Testes novos rodam Nest, PostgreSQL e SQS reais no processo de teste, com banco e
  filas descartáveis; os testes distribuídos existentes continuam exigindo Bun.spawn.
  Consumers distintos do caso de observabilidade usam filas distintas: abortar um
  long poll pode deixar ReceiveMessage em voo no servidor. Reutilizar imediatamente
  a fila permitia que o poll antigo tornasse invisível uma mensagem do novo cenário.
  Não se ampliou timeout/retry nem se acrescentou sleep para esconder a disputa.
- Dependências pino/prom-client exigidas por D12 instaladas; cache Bun da sessão em
  `.scratch/bun-cache` porque o cache global não permite escrita. `.scratch/` ignorado
  para não versionar cache, logs ou tentativas de worktree.

## D23. Correções da auditoria (fase 08) [autopilot]

- **[interpretação]** Crédito cujo saldo resultante excederia `NUMERIC(20,2)` é
  rejeição de negócio `BALANCE_LIMIT_EXCEEDED`. A capacidade é verificada em centavos
  bigint, depois de validar moeda/player/referência e antes de qualquer movimento.
  Não arredondar, truncar, saturar ou ampliar o schema. O limite exato continua válido.
  Rejeição congela o saldo observado, grava inbox/outbox no mesmo commit e permite
  replay original. A mesma decisão atende HTTP, SQS, worker e resolução ansiosa:
  uma WIN pendente inválida não pode desfazer a BET válida que disponibilizou a referência.
- Erros nos logs e no atributo `detail` da DLQ carregam apenas código de aplicação/
  domínio, SQLSTATE de cinco caracteres ou `UNEXPECTED_ERROR`. Mensagem, stack,
  cause, detail e conversão textual de objetos arbitrários não são seguros: o driver
  PostgreSQL pode incluir o JSON financeiro na mensagem (comprovado com erro `22P02`).
  O filtro HTTP usa o logger JSON existente. A consolidação pino/métricas permanece
  na fase prevista; esta correção somente elimina o vazamento nos caminhos existentes.
- Correção da promessa de D18: `aggregateId = walletId` conserva o agrupamento FIFO,
  mas publishers concorrentes **não garantem ordem de commit**: `UPDATE RETURNING`
  não tem ordem definida e um lease/backoff anterior não bloqueia eventos posteriores.
  O contrato é at-least-once por `eventId`, como §11. Consumidores de projeção de saldo
  devem deduplicar por `eventId` e avançar somente para `walletVersion` maior; operações
  que precisem da sequência completa devem detectar lacunas e reconciliar. Não confiar
  na ordem de entrega para aplicar débitos/créditos. Não introduzido lock global nem
  serialização de todas as wallets para cumprir uma promessa adicional à especificação.
- Hipótese de regex aceitar LF final foi descartada: padrões sem flag `m` rejeitam
  `"1.00\n"`/`"BRL\n"` no Bun usado, e já existe teste de amount com LF. Sem alteração
  de regex ou relaxamento de validação. Evidências e limites em `AUDITORIA.md`.

## D22. Publisher e resolução de pendências (fase 07) [autopilot]

- `SqlBackgroundStore`: claim da outbox em transação curta com `SKIP LOCKED`, lote 50,
  lease de 30 s e `locked_by = INSTANCE_ID` (fallback UUID por processo). Renova cada
  evento antes do envio; renovação e conclusão condicionadas a id, dono, vencimento
  original e lease ainda vigente. Datas do token são truncadas a milissegundos no SQL,
  preservando a comparação exata com `Date` do JS. Um dono atrasado não marca o lease
  que outro publisher assumiu. Após sucesso os campos de lease permanecem (D20).
- SQS recebe somente o envelope persistido; grupo = wallet, dedupe = eventId. Toda
  chamada SQS acontece depois de fechar a transação de claim/renovação. Envio tem prazo
  de 10 s, menor que o lease; falha persiste backoff do domínio, libera lease e grava
  `SQS_PUBLISH_FAILED`, sem copiar erro do SDK que possa conter payload financeiro.
  Evento nunca é descartado. Os dois checkpoints de crash da outbox estão ligados.
- `GET /metrics` expõe `outbox_lag_seconds` como gauge no formato Prometheus, calculado
  diretamente sobre a outbox confirmada, inclusive eventos em backoff/lease. Esta fase
  implementa somente a métrica de lag; a consolidação da observabilidade continua em S9.
- O schema congelado não tem colunas de lease para pendências: o claim usa
  `next_reference_attempt_at = agora + 30 s` como reserva recuperável. `SKIP LOCKED`
  impede esperar por itens já reivindicados. Essa transação NÃO toma lock de wallet.
  Ela termina antes do processamento, que sempre trava wallet → transação e relê
  status/token. Claim velho não consome tentativa nem reprocessa resultado terminal.
- D8: 5 s iniciais; falhas de resolução reagendam 10/20/40/80/160/300/300 s; a oitava
  tentativa sem referência rejeita com `REFERENCE_NOT_FOUND` e evento. TTL adicional
  de 915 s desde a criação evita espera ilimitada após crashes de reivindicadores.
  **[interpretação]** limite/TTL só rejeita quando a referência continua ausente ou
  não terminal; uma referência válida já disponível é aplicada e validada normalmente.
- `settleWager` compartilha a aplicação de decisões entre entrada HTTP/SQS e resolução:
  transição, UPDATE condicionado, ledger e eventos ficam no mesmo commit. Resolução
  ansiosa percorre dependências da mesma wallet em lotes de leitura de 50, sem limite
  total artificial, incluindo cascatas de referências rejeitadas. Sob a wallet já
  travada, espera por locks curtos de claim em vez de pular uma pendência. Nunca toma
  a wallet após travar transações. A resposta da referência preserva seu próprio saldo
  original, mesmo que outras operações mudem a wallet no mesmo commit.
- Os laços de publisher e pendências são independentes; cada processo os inicia no
  bootstrap e os encerra antes de fechar pool/SQS. Poll de 250 ms é agendamento de
  produção, não espera acrescentada a testes de concorrência.
- Verificação desta sessão limitada pelo ambiente: Docker/`Bun.spawn`, criação de
  worktree e, intermitentemente, o próprio PowerShell negaram acesso. Não contornar esses bloqueios
  substituindo processos reais ou retirando proteções; `/prove-red` continua pendente.

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

## D25. Escopo da documentação final (fase 10) [autopilot]

- README e ARCHITECTURE descrevem o código atual e as limitações da auditoria,
  sem tratar propostas anteriores como implementadas: SQL explícito via MikroORM
  substitui EntitySchema (D19); a saída não tem ordem de commit (D23); IdP é desenho,
  não autenticação efetiva (D24). Não alterados schema, domínio ou testes nesta fase.
- **[interpretação]** Apenas validar token não autoriza consultas sem providerId na
  rota. O desenho futuro exige política de acesso a wallet/transação e escopos,
  além da comparação de providerId já existente; não se presume propriedade da
  wallet a partir do token. Essa lacuna fica explícita, sem implementar nova fase.
- Portões antigos bloqueados e sabotagens pendentes continuam como pendências.
  Resultados da fase 10 são registrados pela execução efetiva em PROGRESS.md;
  documentação não converte teste não executado em prova concluída.

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
  eventos de uma wallet caem no mesmo `MessageGroupId`; ordem de commit não é garantida
  entre publishers (correção da auditoria, D23). Campos ausentes
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

## D19. Use cases + HTTP (fase 04) [autopilot]

- **Persistência em SQL explícito, sem EntitySchema (por ora)**: `MikroOrmUnitOfWork.run` =
  `em.fork().transactional(...)`; dentro dela os repositórios usam o `Knex.Transaction` do
  próprio EM (`em.getTransactionContext()`) com placeholders `?` → parâmetros posicionais do
  driver (nada interpolado). Motivo: o caminho crítico inteiro é SQL que o flush do UoW não
  expressa (`FOR UPDATE`, UPDATE condicionado a versão/saldo, tradução de 23505 por nome de
  constraint). Registros (`records.ts`) + mappers → `X.rehydrate`. O knex/pg do MikroORM devolve
  TIMESTAMPTZ como string: o mapper normaliza para ISO-8601 estrito (sem confiar em parsing
  leniente) e recusa formato inesperado.
- **`lock_timeout`** por transação via `set_config('lock_timeout', $1, true)` (5 s, `LOCK_TIMEOUT_MS`);
  `55P03`, `40001`, `40P01`, `08xxx`, `57P0x`, pool esgotado → `TransientInfrastructureError` → 503
  `Retry-After: 1`. **`DB_POOL_MAX`** (padrão 20) define o pool do knex.
- **UPDATE da wallet**: `WHERE id AND version = v_anterior AND balance_amount = saldo_anterior AND
  balance_amount >= débito`; 0 linhas → `LostUpdateError` (500). Com o lock é inalcançável; sem
  o lock (sabotagem da linha 2) é o que transforma lost update em erro em vez de saldo errado.
- **Corrida 23505** em `uq_tx_idempotency_key`/`uq_tx_provider_external` (só possível contra
  transação de OUTRA wallet, pois a mesma wallet está serializada): rollback e nova tentativa
  completa (no máximo 3), que relê → replay/409.
- **Ordem das verificações sob o lock**: key (replay/409) → (provider, external) com outra key
  (409) → wallet inexistente (422 `WALLET_NOT_FOUND`, `transactionId: null`, nada persistido) →
  moeda (`CURRENCY_MISMATCH`) → player (`WALLET_PLAYER_MISMATCH`) → referência → saldo.
- **Referências** (`wager-rules.ts`, pura): WIN/LOSS só podem referenciar BET; REFUND → BET;
  ROLLBACK → BET/WIN/REFUND. Ordem: escopo (provider, player, wallet, moeda, rodada) → tipo →
  estado → valor (só reversões) → já revertida (só reversões). Referência ausente **ou ainda não
  terminal** (ex.: ROLLBACK de um REFUND pendente) → PENDING_REFERENCE (nunca credita antes da
  referência existir); referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`. WIN/LOSS com
  referência ausente também aguardam (mais seguro que creditar um WIN sem BET).
- **PENDING_REFERENCE**: primeira tentativa em +5 s (D8), evento `WagerTransactionPendingReference`,
  202. Resolução ansiosa e worker ficam para a fase do worker (PLANO S7), como manda esta fase.
- **HTTP**: corpo único para 200/202/422 `{transactionId, status, balance, failureCode, idempotentReplay}`
  (`balance` null em PENDING_REFERENCE e WALLET_NOT_FOUND; `failureCode` null fora de rejeição).
  FAILED (inalcançável por ora) → 422. `kind: OPENING` → 400 `INVALID_PAYLOAD`; BET com referência
  → 400; REFUND/ROLLBACK sem referência → 400. `referenceExternalTransactionId: null` = ausente.
  UUIDs normalizados para minúsculas na borda (o escopo compara strings). Id malformado em GET → 404.
  JSON malformado → 400 `INVALID_PAYLOAD`. `X-Correlation-Id` aceito (ASCII visível ≤ 128) ou gerado.
- **OPENING** emite `WagerTransactionProcessed` + `WalletBalanceChanged` (o saldo mudou); as
  invariantes I6/I7 isentam OPENING, mas consumidores do saldo precisam do primeiro movimento.
- **Consultas**: `GET /wallets/:id`, `GET /wagering/transactions/:id`,
  `GET /providers/:p/wagering/transactions/:ext` feitos; ledger paginado e reconciliação = PLANO S9.

## D20. FaultInjector e harness multi-processo (fase 05) [autopilot]

- **Porta** `application/ports/fault-injector.ts`: `checkpoint(point)` com 4 pontos nomeados
  (`before-commit`, `after-commit-before-ack`, `after-claim-before-publish`,
  `after-publish-before-mark`). Produção: `NO_FAULTS`. `ProcessKillFaultInjector` só é criado
  com `NODE_ENV=test` **e** `FAULT_POINT=<nome>`; em qualquer outro `NODE_ENV` o `FAULT_POINT`
  é ignorado. Nome desconhecido → `InvalidConfigError` na subida (typo em teste não pode virar
  no-op silencioso). No ponto armado: `process.kill(process.pid, "SIGKILL")` — sem `finally`,
  sem shutdown hook (provado em `test/unit/fault-injector.test.ts` com subprocesso real; no
  Windows o Bun traduz para `TerminateProcess`, exit 1 sem sinal).
- **Onde estão os pontos hoje**: `before-commit` no fim de `ProcessWagerTransaction.attempt`
  (dentro do `uow.run`, depois de transação/ledger/outbox; replays não passam por ele);
  `after-commit-before-ack` no controller HTTP entre o retorno do use case (já commitado) e a
  resposta — para o HTTP a resposta É o ack. O consumer SQS (fase 06) chama o mesmo ponto antes
  do `DeleteMessage`; o publisher (fase 07) chama os outros dois.
- **Contrato que o publisher (fase 07) tem de honrar** (os testes de §13.6 dependem dele): corpo
  da mensagem em `wallet-events.fifo` = `outbox_messages.payload` (envelope com `eventId`);
  `locked_by` = `INSTANCE_ID` do processo (o harness injeta; fallback aleatório) e **permanece**
  após publicar — é a auditoria de quem publicou e a prova de que os dois publishers trabalharam.
- **Harness** `test/support/cluster.ts`: N processos `bun run src/main.ts` (porta livre cada,
  mesmo banco, mesmas filas criadas uma vez), `/health/ready` antes de liberar; `kill` (SIGKILL),
  `stop` (SIGTERM), `restart`/`restartAll` (processo NOVO, outra porta, outro pid),
  `waitForExit` com prazo (para pontos de falha), `sendWagerMessage` (§10), `queueDepth`.
  Pool por instância 25 (3 × 25 + pool do teste < `max_connections` 100; 25 > 50/3 para a BET 50×).
- **`eventually`**: estados EVENTUAIS (worker, publisher, redelivery) são reconsultados até um
  prazo que só transforma "nunca acontece" em falha legível com o último valor — não é sleep
  para passar: o teste exige o estado.
- **Testes §13 concorrência** (`test/concurrency/`): 1–3 `http-races`, 4 `multi-instance`, 5
  `crash-after-commit` (HTTP before-commit e after-commit-before-ack verdes; SQS vermelho até
  a fase 06), 6 `outbox-publishers` (vermelho até 07), 7 `out-of-order-reference` (vermelho até
  07), 8 `restart-consistency`. A disputa é provada no banco (`contend`/`countLockWaiters`).

## D21. Consumer SQS + inbox (fase 06) [autopilot]

- **Onde**: `src/interface/sqs/` (adaptador de entrada, como o controller HTTP): `wager-message.ts`
  (envelope §10 → `WagerCommand` com a MESMA validação do DTO HTTP; key = `data.idempotencyKey`),
  `retry-policy.ts` (classificação + backoff, puros), `wager-consumer.ts` (laço). Ligado no
  `AppModule` por `WagerConsumerLifecycle` (start no bootstrap; `stop` em
  `beforeApplicationShutdown`, antes de o pool fechar). `SQS_CONSUMER_ENABLED=false` desliga.
- **Inbox no use case**: `ProcessWagerTransaction.execute(command, delivery?)`. Ordem dentro da
  transação: lock da wallet → `INSERT inbox … ON CONFLICT DO NOTHING` → (key → decisão →
  escritas → outbox) → `UPDATE inbox SET processed_at` → checkpoint `before-commit` → COMMIT.
  Inbox e efeito saem no mesmo commit; a linha de inbox só existe confirmada já processada.
  `payload_hash` da inbox = hash de negócio D4.
- **Redelivery** (inbox já existe, mesmo hash): não decide de novo; devolve o original achado por
  `(provider, external)` com o mesmo hash (a key não entra no hash, então outra key na reentrega
  ainda é a mesma mensagem). Sem transação ⇒ o original foi WALLET_NOT_FOUND e **continua** sendo,
  mesmo que a wallet tenha sido criada depois **[interpretação: mensagem tratada não é
  reprocessada]**. WALLET_NOT_FOUND pela fila grava a inbox (não há FK) e faz ack.
- **Classificação** (D9): resultado de negócio (PROCESSED, REJECTED, PENDING_REFERENCE,
  WALLET_NOT_FOUND, replay) → ack. Permanente → `SendMessage` à DLQ com atributos `reason`,
  `detail`, `sourceMessageId`, `receiveCount` e só então `DeleteMessage` (crash no meio = nova
  DLQ, dedup FIFO pelo `MessageId`): `INVALID_JSON`, `INVALID_ENVELOPE`, `INVALID_PAYLOAD`,
  `IDEMPOTENCY_CONFLICT` **[escolha: conflito de key pela fila é veneno auditável, não ack
  silencioso]**, `INBOX_PAYLOAD_MISMATCH` (mesmo messageId, outro payload). Transitório
  (`TransientInfrastructureError`) e erro INESPERADO → `ChangeMessageVisibility` =
  `min(base·2^(n−1), max)` (n = ApproximateReceiveCount; padrão base 2 s, teto 60 s); a
  RedrivePolicy (5) é a rede de segurança — o consumer nunca manda transitório à DLQ por conta própria.
  Falha ao enviar à DLQ vira retry.
- **Ordem**: lote agrupado por `MessageGroupId`; grupos em paralelo, mensagens do grupo em
  sequência. Transitório no meio do grupo devolve o resto do grupo (visibilidade 0; o FIFO não
  entrega antes da que falhou). Otimização — a correção é lock por wallet + inbox.
- **Heartbeat**: a cada visibilidade/3 o lote em andamento renova `SQS_VISIBILITY_TIMEOUT_SECONDS` (30).
- **Drain (SIGTERM)**: aborta o long poll, espera o lote até `SQS_SHUTDOWN_GRACE_MS` (8 s,
  < 10 s do harness), devolve com visibilidade 0 o que não terminou/não começou. Se uma
  transação ainda confirmar depois, a reentrega é replay (inbox). **No Windows o Bun entrega
  SIGTERM como TerminateProcess** (verificado: handler não roda, exit 143), então o drain é provado
  em `test/unit/wager-consumer-drain.test.ts` (SQS falso), não por sinal em processo real.
- **Postgres congelado** (`docker pause`): o servidor não responde nem fecha o socket; a query —
  e o ROLLBACK depois dela — esperaria para sempre. Defesa: socket do `pg` com prazo de
  inatividade `DB_SOCKET_TIMEOUT_MS` (15 s, obrigatoriamente > `LOCK_TIMEOUT_MS`), destruído ao
  vencer ⇒ query falha, knex descarta a conexão, o servidor aborta a transação ao voltar; a
  conexão NUNCA é reusada com transação meio-aberta (reusar uma conexão cujo `BEGIN…` ficou
  pendurado poderia confirmar escritas parciais de outra tentativa). Também
  `DB_CONNECT_TIMEOUT_MS` (5 s) e `DB_ACQUIRE_TIMEOUT_MS` (10 s). Ociosas também caem no prazo
  (o pool recria). `Transaction query already complete` (knex, conexão perdida no meio) é transitório.
- **Log**: JSON por linha (`src/infrastructure/logging/json-logger.ts`, `component: sqs-consumer`)
  com `messageId, sqsMessageId, receiveCount, correlationId, walletId, providerId, transactionId,
  status` — sem valores. Os testes de integração leem esses logs para provar QUE houve retry.
- **Linha 12 da matriz (sem a inbox, a D4 ainda segura?)**: sim para a mesma key (replay pela
  key) e para outra key com mesmo `(provider, external)` (409 → que pela fila seria DLQ
  `IDEMPOTENCY_CONFLICT` em vez de ack). A inbox é o que transforma redelivery em ack silencioso
  e detecta messageId reaproveitado com outro payload.
- **Revalidação em ambiente restrito (2026-10-29) [autopilot]**: o portão deve continuar
  vermelho quando Docker nega acesso ao pipe ou `Bun.spawn` retorna EPERM. Não substituir os
  testes de processo/crash por execução no mesmo processo, não remover o SIGKILL e não
  transformar falha de infraestrutura do harness em sucesso. Resultados e pendências atuais
  ficam em `docs/PROGRESS.md`; o relato anterior de verde não valida esta nova execução.
