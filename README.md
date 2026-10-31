# Distributed Wagering Processor

Processador de apostas em NestJS. Recebe BET, WIN, LOSS, REFUND e ROLLBACK
por HTTP ou SQS. Saldo, ledger e dedupe ficam no PostgreSQL, no mesmo commit.
Dinheiro vai pela API como string; as contas usam centavos em `bigint`.

Para rodar, comece pelo Compose abaixo. Para entender alguma escolha menos
óbvia, veja [ARCHITECTURE.md](ARCHITECTURE.md) e [DECISOES.md](docs/DECISOES.md).
O enunciado está em [CHALLENGE.md](docs/CHALLENGE.md), e o mapa de garantias
e testes, em [INVARIANTES.md](docs/INVARIANTES.md).

## Pré-requisitos

- Bun 1.x, com instalação de dependências e criação de subprocessos permitidas.
- Docker com Compose v2 e daemon acessível. No Windows, Docker Desktop com
  containers Linux.
- Git no PATH: o scanner de regras usa `git ls-files`.
- Portas locais 3000 (HTTP), 55432 (PostgreSQL) e 4566 (SQS) disponíveis.
- Para os testes, usuário PostgreSQL com permissão para criar e remover bancos.
  Os testes usam bancos descartáveis e templates migrados. Os casos de interrupção
  do PostgreSQL também precisam executar comandos Docker.

Os blocos `bash` usam sintaxe POSIX. No PowerShell, os comandos simples são iguais;
há um equivalente do laço de concorrência ao final. No Windows, diferenças de
SIGTERM/SIGKILL e bloqueios de subprocessos podem impedir provas de crash e drain;
veja os limites em ARCHITECTURE.md.

## Rodando aqui

Na raiz do projeto:

```bash
bun install
docker compose up -d --wait
bun run sqs:setup
bun run migration:up
bun run start
```

O Compose inicia PostgreSQL 16 e MiniStack, o emulador SQS escolhido neste projeto.
O healthcheck do emulador verifica acesso à porta; `sqs:setup` espera a API SQS
responder e cria a topologia de forma idempotente:

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | Entrada de operações; redrive após 5 recebimentos |
| `wager-transactions-dlq.fifo` | Mensagens permanentes e mensagens esgotadas pelo redrive |
| `wallet-events.fifo` | Eventos publicados pela outbox |

A aplicação roda no host, fora do Compose. A subida da aplicação não aplica
migrations nem cria filas. Em outro terminal, confira:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

`live` verifica o processo. `ready` consulta PostgreSQL e resolve a fila de entrada
no SQS; uma dependência indisponível retorna 503. `/metrics` expõe Prometheus.
Essas rotas são abertas. Os endpoints financeiros também estão sem autenticação
efetiva: existe um guard com adapter no-op, conforme a opção permitida na §2 do
enunciado. O desenho com IdP externo está em ARCHITECTURE.md.

## Configuração

Os padrões de [app-config.ts](src/infrastructure/config/app-config.ts) apontam para
o Compose local. Bun pode carregar um `.env` local; não há arquivo de exemplo a copiar.

| Variável | Padrão | Efeito |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:55432/wagering` | Banco da aplicação e base de conexão dos testes |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | API do emulador SQS |
| `AWS_REGION` | `us-east-1` | Região SQS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test`, `test` | Credenciais locais do emulador |
| `PORT` | `3000` | HTTP |
| `INSTANCE_ID` | UUID por processo | Identifica o dono de leases da outbox |
| `READINESS_TIMEOUT_MS` | `2000` | Prazo de cada probe |
| `DB_POOL_MAX` | `20` | Conexões por processo |
| `LOCK_TIMEOUT_MS` | `5000` | Prazo de espera por lock em cada transação |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Prazo para abrir conexão |
| `DB_ACQUIRE_TIMEOUT_MS` | `10000` | Prazo para obter conexão do pool |
| `DB_SOCKET_TIMEOUT_MS` | `15000` | Encerra socket sem tráfego; deve ser maior que `LOCK_TIMEOUT_MS` |
| `SQS_WAGER_QUEUE` | `wager-transactions.fifo` | Fila de entrada |
| `SQS_WAGER_DLQ` | `wager-transactions-dlq.fifo` | DLQ de entrada |
| `SQS_WALLET_EVENTS_QUEUE` | `wallet-events.fifo` | Eventos de saída |
| `SQS_CONSUMER_ENABLED` | `true` | Ativa o consumer de entrada |
| `SQS_WAIT_TIME_SECONDS` | `20` | Long polling |
| `SQS_MAX_MESSAGES` | `10` | Tamanho do lote recebido |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibilidade, renovada por heartbeat |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | `2`, `60` | Backoff de falhas transitórias |
| `SQS_SHUTDOWN_GRACE_MS` | `8000` | Prazo de drain do consumer |

`POSTGRES_HOST_PORT` e `SQS_HOST_PORT` mudam somente as portas publicadas pelo
Compose. Se alterá-las, ajuste também `DATABASE_URL` e `AWS_ENDPOINT_URL` na aplicação
e nos testes. Credenciais `test` e o usuário `postgres` são configuração local.

`FAULT_POINT` é exclusivo de testes: com `NODE_ENV=test`, mata o processo em um dos
checkpoints descritos em ARCHITECTURE.md. Fora desse ambiente não ativa falhas;
um nome desconhecido é erro de configuração.

## Migrations

```bash
bun run migration:up
bun run migration:down
```

`up` aplica todas as pendentes; `down` reverte a última aplicada. Para reverter todas
em um banco descartável: `bun run scripts/migrate.ts down --all`. O down inicial
remove as tabelas do serviço e seus dados. O migrator usa a lista versionada em
`migrations/index.ts`, transação e triggers habilitados; não depende do CLI do ORM.

`docker compose down` encerra o ambiente local. O Compose não configura volumes
persistentes nomeados; não o use como estratégia de retenção dos dados.

## Contrato HTTP e fila

| Rota | Finalidade |
|---|---|
| `POST /wallets` | Abre wallet; saldo positivo gera OPENING e crédito no mesmo commit |
| `GET /wallets/:walletId` | Saldo e versão atuais |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Ledger crescente por versão; cursor opaco, limit de 1 a 100 |
| `POST /wagering/transactions` | Submete operação; exige `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consulta transação interna |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade do provedor |
| `POST /wallets/:walletId/reconciliation` | Compara saldo e ledger sem corrigir divergências |

Os exemplos completos de requisição e do envelope SQS estão nas §§9–10 de
[CHALLENGE.md](docs/CHALLENGE.md). Um valor válido é
`{"amount":"25.00","currency":"BRL"}`; `25`, `"25"`, `"25.0"`, negativos e
notação científica não são entradas monetárias válidas.

Criação retorna 201; processamento 200; pendência de referência 202; rejeição de
negócio 422; entrada inválida 400; conflito de idempotência ou wallet duplicada 409;
consulta ausente 404; infraestrutura transitória 503 com `Retry-After: 1`.
Replay preserva o resultado e o saldo da decisão original, com
`idempotentReplay: true`. Em 503, reenvie com a mesma chave. As interpretações de
referências e a taxonomia dos códigos estão em ARCHITECTURE.md.

Na entrada SQS, envie o envelope `WagerTransactionRequested` da §10 com
`MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. O campo
`data.idempotencyKey` substitui o header HTTP. A inbox usa o `messageId` do envelope,
não o identificador de transporte atribuído pelo SQS. FIFO reduz disputa; a
deduplicação financeira continua no PostgreSQL.

## Verificação e testes

Suba o Compose antes das suítes reais. Elas criam bancos e filas isolados, usam as
migrations de produção e iniciam processos Bun quando o cenário exige múltiplas
instâncias ou crash. Rode os comandos a partir da raiz e aguarde cada um terminar.

No dia a dia:

```bash
bun run typecheck
bun run lint
bun test test/unit
```

Com o Compose de pé, rode também `test:acceptance`, `test:integration` e
`test:concurrency` (todos com `bun run`). Eles pegam schema/HTTP, banco e SQS,
workers, disputas entre processos e crashes. Não são testes só em memória.

`bun run test:all` roda as suítes, mas não inclui lint, typecheck,
`bun run scripts/scan-forbidden.ts` nem `bun run verify:schema`. O scanner olha
arquivos versionados; o verificador de schema precisa do Postgres real.

`bun test test/unit` equivale a `test:unit`. Os testes que mexem em dinheiro
terminam com `assertGlobalInvariants(db)` sobre I1–I8 de
`reference/sql/invariants.sql`: saldo igual ao reconstruído pelo ledger, versões,
unicidade, referências e eventos confirmados. As lacunas conhecidas de prova estão
em ARCHITECTURE.md.

Para conferir tudo como no CI:

```bash
docker compose up -d --wait
bun run sqs:setup
bun run scripts/scan-forbidden.ts
bun run typecheck
bun run lint
bun run test:unit
bun run migration:up && bun run migration:down && bun run migration:up
bun run verify:schema
bun run test:acceptance
bun run test:integration
for i in 1 2 3; do bun run test:concurrency || exit 1; done
```

A suíte de concorrência roda três vezes porque uma falha intermitente nela é tratada
como defeito, não como ruído. Em PowerShell, o laço equivalente é:

```powershell
foreach ($round in 1..3) {
  bun run test:concurrency
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Sem acesso ao Docker ou sem permissão para `Bun.spawn`, os testes de crash,
multi-instância e Postgres pausado falham por ambiente.
