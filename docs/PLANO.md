# Plano de 3 dias com Claude Code

Princípio que governa tudo: **o Claude escreve o código, mas não escreve sozinho a régua
que mede o código.** Os testes de aceitação (as eliminatórias) nascem antes da
implementação, em sessão separada, são revisados por você e congelados por hook. A
implementação acontece contra uma régua que ela não pode entortar. Depois, um auditor
em contexto limpo e as sabotagens (`/prove-red`) confirmam que a régua mede de verdade.

Analogia de Minecraft: `SELECT … FOR UPDATE` é um baú que só um jogador abre por vez —
quem chega depois espera do lado. Cada wallet é um baú diferente, então mil jogadores
mexem em mil baús ao mesmo tempo; o que não pode existir é um cadeado único no portão
da vila inteira (o "lock global" eliminatório).

---

## Dia 0 — hoje, ~1 h (preparação, sem código de produção)

```bash
mkdir jungle-wagering && cd jungle-wagering && git init
cp -r <kit>/. .                 # CLAUDE.md, docs/, reference/, .claude/
git add -A && git commit -m "chore: kit de trabalho e especificação"
claude
```

- `mkdir` cria a pasta; `cd` entra nela; `git init` cria o repositório.
- `cp -r <kit>/. .` copia **recursivamente** (`-r`) todo o conteúdo do kit, inclusive
  arquivos ocultos como `.claude/` (o `/.` no fim garante isso), para a pasta atual (`.`).
- `git add -A` coloca no índice **todos** (`-A`, *all*) os arquivos, novos e alterados;
  `commit -m "…"` grava com a mensagem dada.
- `claude` abre o Claude Code na pasta.

Para trabalhar com autonomia sem aprovar cada edição: `claude --permission-mode acceptEdits`
(`--permission-mode` escolhe a política de permissão; `acceptEdits` aceita edições de
arquivo automaticamente e continua pedindo para comandos fora da lista `allow` do
`.claude/settings.json`). Evite pular permissões por completo fora de um container.

**Sessão 0 — Plan Mode** (Shift+Tab até aparecer *plan mode*; nele o Claude só lê e planeja):

> Leia docs/CHALLENGE.md inteiro, CLAUDE.md, docs/DECISOES.md, docs/INVARIANTES.md e
> reference/sql/001_schema.sql. Não escreva código. Quero: (1) uma lista de toda
> ambiguidade do enunciado que DECISOES.md ainda não resolve, com a sua proposta;
> (2) os riscos técnicos do stack Bun + NestJS + MikroORM + LocalStack, em ordem de
> probabilidade de me fazer perder meio dia; (3) discordâncias fundamentadas com
> qualquer decisão em DECISOES.md. Seja adversarial com o meu plano.

Leia a resposta com calma, ajuste `DECISOES.md` você mesmo. Isto é o que você vai
defender na apresentação — se não entendeu uma decisão, pergunte agora.

---

## Dia 1 — fundação e caminho crítico

### S1 · Spike do stack (timebox 2 h — é o maior risco de prazo)

> Monte o esqueleto mínimo: Bun 1.x, TypeScript strict, NestJS, MikroORM com
> @mikro-orm/postgresql e migrations, docker-compose com postgres:16 e localstack
> (SQS) com healthchecks, script que cria wager-transactions.fifo,
> wager-transactions-dlq.fifo (redrive maxReceiveCount=5) e wallet-events.fifo.
> Scripts em package.json (os mesmos que .github/workflows/ci.yml chama): typecheck,
> lint, sqs:setup, migration:up, migration:down, verify:schema
> (reference/verify-schema.ts), test:acceptance, test:integration, test:concurrency,
> test:all. Emulador de SQS: a imagem atual do LocalStack exige auth token desde
> 23/03/2026; teste primeiro o MiniStack (ministackorg/ministack, porta 4566, sem
> token) e PROVE que FIFO, MessageGroupId, deduplicação e RedrivePolicy funcionam; se
> não funcionarem, use LocalStack com token e me diga o que configurar. Implemente só /health/live e
> /health/ready (SELECT 1 + GetQueueUrl). Prova de pronto: `docker compose up -d --wait`,
> migration vazia up/down, um teste de integração que fala com o Postgres e o SQS REAIS.
> Se algo do Bun com Nest/MikroORM (decorators, CLI de migrations) não funcionar,
> me diga o problema e a alternativa antes de improvisar.

Portão: tudo verde → commit → configure o GitHub (docs/EQUIPE.md, seção GitHub Pro) e
confirme o CI verde no primeiro push. Se o CLI de migrations do MikroORM brigar com o Bun,
rode o Migrator programaticamente (`bun run src/infrastructure/db/migrate.ts`).

### S2 · Testes de aceitação (sessão separada; você revisa; depois congela)

Opcional: escrever estes testes com o Codex (outra família de modelo) dá uma régua mais
independente — ver docs/EQUIPE.md. Sem ele, use o prompt abaixo numa sessão nova do Claude.

`/clear` antes (limpa o contexto: sessão nova, olhar novo).

> Leia docs/CHALLENGE.md §6–§13, docs/INVARIANTES.md e reference/verify-schema.ts.
> Escreva SOMENTE testes, em test/acceptance/, cobrindo as linhas 1, 2, 3, 7, 8, 19,
> 24, 26 da matriz, mais o cenário obrigatório da §8 e "a mesma aposta 50× em paralelo"
> via HTTP. Crie test/support/ com: banco isolado por arquivo (CREATE DATABASE … TEMPLATE),
> cliente HTTP, barreira de largada para paralelismo real, e assertGlobalInvariants(db)
> que executa reference/sql/invariants.sql. Pool de conexões ≥ paralelismo. Cada teste
> confere o BANCO, não só o status HTTP. Não implemente nada de produção: os testes
> devem falhar agora — rode e me mostre que falham pelo motivo certo.

Você revisa linha a linha (é a sua régua). Commit. A partir daqui o hook
`guard-protected` bloqueia edições em `test/acceptance/**`. Para ajustar um teste
deliberadamente, abra uma sessão com `ALLOW_PROTECTED_EDITS=1 claude` (a variável de
ambiente só vale para aquele processo).

### S3 · Migration real + domínio (TDD)

> Porte reference/sql/001_schema.sql para a migration inicial do MikroORM (up e down
> idênticos ao gabarito, incluindo triggers diferidos). Teste de round-trip das
> migrations. Depois o domínio em src/domain com TDD: Money (bigint, regex de
> DECISOES.md D2, tabela de entradas inválidas), Wallet, WagerTransaction (transições
> explícitas, terminais imutáveis), WalletLedgerEntry, InboxMessage, OutboxMessage,
> IntegrationEvent abstrato + 4 subclasses, failure codes. Para cada classe: teste
> vermelho, implementação, teste verde. Domínio sem nenhum import de framework.

### S4 · Use cases + HTTP

> Implemente OpenWallet e ProcessWagerTransaction seguindo À RISCA o "Contrato
> transacional do caminho crítico" do CLAUDE.md, e os endpoints da §9 com o
> mapeamento D5. Regras BET/WIN/LOSS/REFUND/ROLLBACK de D7, PENDING_REFERENCE de D8
> (sem o worker ainda). Objetivo: test/acceptance verde sem tocar em test/acceptance.
> Se algum teste parecer errado, pare e argumente com a seção do README.

**Portão do Dia 1:** aceitação verde; `bun run verify:schema` verde; você consegue
explicar em voz alta por que as duas apostas de 80 não furam o saldo.
Rode `/prove-red section-8` e `/prove-red idempotency-50x`. Commit.

---

## Dia 2 — mensageria, falhas e múltiplas instâncias

### S5 · FaultInjector e harness multi-processo (antes das features!)

> Crie a porta FaultInjector (no-op em produção; ativável só com NODE_ENV=test e
> FAULT_POINT=<nome>) com checkpoints: before-commit, after-commit-before-ack,
> after-publish-before-mark, after-claim-before-publish. No checkpoint o processo
> faz process.kill(process.pid, "SIGKILL"). Em test/support, um harness que sobe N
> instâncias reais com Bun.spawn (portas distintas, mesmo banco e filas), espera
> /health/ready, mata e reinicia instâncias. Escreva (vermelhos por enquanto) os
> testes de concorrência 4, 5, 6, 7 e 8 da §13.

### S6 · Consumer SQS + inbox

> Consumer conforme D9: mesmo use case do HTTP, inbox na mesma transação, ack só
> após commit, classificação negócio/transitório/permanente, visibility backoff,
> DLQ explícita para permanentes, redrive como rede de segurança, SIGTERM com drain.
> Testes de integração: redelivery 3×, transitório que se recupera (pare o Postgres
> com docker compose pause), permanente → DLQ, 5 recebimentos → DLQ.

### S7 · Outbox publisher + worker de pendências

> Publisher conforme D10 (lease + SKIP LOCKED, sem transação aberta durante I/O,
> backoff, métrica de lag) e worker de PENDING_REFERENCE conforme D8 (inclui
> resolução ansiosa no mesmo commit da referência, respeitando a ordem de locks
> wallet → transações). Faça passar os testes de concorrência escritos na S5.

**Portão do Dia 2:** as 8 situações da §13 "Concorrência" verdes, rodando 3× seguidas
(`for i in 1 2 3; do bun run test:concurrency || break; done` — `for … do … done`
repete o comando; `|| break` sai do laço na primeira falha). Rode `/prove-red` para
as linhas 11, 12, 14, 15 e 17 da matriz. Commit.

---

## Dia 3 — prova, observabilidade, documentação, defesa

### S8 · Auditoria em contexto limpo (manhã cedo)

`/clear` e então:

> Use o subagente invariant-auditor para auditar o repositório inteiro contra as
> eliminatórias e a matriz. Em paralelo, use o subagente test-skeptic sobre test/.
> Consolide os achados por severidade, sem corrigir nada ainda.

Corrija os achados críticos numa sessão nova, um por commit.

### S9 · Observabilidade + reconciliação + consultas

> D12 completo (pino com AsyncLocalStorage e redact, prom-client em /metrics com as
> métricas listadas), endpoint de reconciliação (divergência logada, contada e
> sinalizada, nunca corrigida), GET /wallets/:id/ledger com cursor opaco
> (base64url de wallet_version) e os demais GETs da §9. Testes de integração.

### S10 · Documentação

> Escreva README.md (pré-requisitos, `docker compose up`, migrations, cada comando de
> teste e o que ele prova) e ARCHITECTURE.md a partir de docs/DECISOES.md e
> docs/INVARIANTES.md: decisões, trade-offs, interpretações do enunciado, limitações
> conhecidas e o que eu faria com mais tempo. Inclua o desenho de autenticação
> não implementada (D11). Tom direto, sem marketing, sem cara de texto gerado.

### S11 (opcional, se sobrar ≥2 h) · `bun run test:load`

Ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock, outbox
lag — com honestidade sobre o que a máquina local distorce.

### S12 · Ensaio da apresentação (não pule)

> Aja como o avaliador técnico da Jungle Gaming. Faça-me 15 perguntas difíceis sobre
> este repositório, uma por vez, esperando minha resposta: concorrência, idempotência,
> outbox, crash, interpretações do enunciado, o que quebra em produção. Depois de cada
> resposta, diga o que faltou.

---

## Hábitos durante os 3 dias

- **Uma fase, uma sessão.** `/clear` entre fases; o `docs/PROGRESS.md` é a passagem de bastão.
- **Commit a cada portão verde.** É o seu botão de desfazer (`git restore`, `git reset`).
- **Paralelismo de sessões só fora do núcleo** (ex.: documentação e métricas no Dia 3)
  usando `git worktree add ../jw-docs -b docs` (`worktree add` cria uma segunda cópia de
  trabalho do mesmo repositório na pasta indicada; `-b docs` cria o ramo `docs` para ela).
  Nunca duas sessões mexendo no caminho crítico.
- **Leia todo diff da migration e do ProcessWagerTransaction.** São as duas peças que a
  banca vai abrir primeiro.
- Se o Claude disser "todos os testes passam", peça: *"mostre a saída do comando e as
  invariantes"*. Saída real, não resumo.
