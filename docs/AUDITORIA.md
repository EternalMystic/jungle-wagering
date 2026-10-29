# Auditoria — fase 08 [autopilot]

Data: 2026-10-29. Ordem cumprida: subagente `invariant_auditor`, seguindo
`.claude/agents/invariant-auditor.md`; depois `test_skeptic`, seguindo
`.claude/agents/test-skeptic.md`. Ambos somente leitura. O agente principal escreveu
regressões, corrigiu produção e executou os comandos. O auditor de invariantes voltou
a revisar o diff final e considerou fechadas as duas ALTA, sem nova regressão ALTA.

Escopo: fases implementadas até 07. Ledger paginado, reconciliação e consolidação de
observabilidade previstos para fase posterior não foram implementados nesta auditoria.
Nenhuma alteração em `test/acceptance/**`, `reference/**` ou `docs/CHALLENGE.md`.

## Achados de produção e tratamento

| ID | Severidade | Área / evidência | Violação / consequência | Correção e teste que prova | Estado |
|---|---|---|---|---|---|
| A01 | ALTA | `src/application/wager-rules.ts:63`; `src/domain/wallet.ts:128`; `src/application/resolve-pending-references.ts:26` | Crédito que excedia NUMERIC(20,2) recebia APPLY e lançava durante Money.add. WIN já aceita como pendência podia abortar a BET válida no mesmo commit ansioso. Worker repetia indefinidamente com referência presente, pois limite/TTL só cobriam WAIT_REFERENCE (§6.1, §7.1). | `Money.canAdd` (`src/domain/money.ts:51`) calcula capacidade em bigint; `decideWager:64` decide REJECT/BALANCE_LIMIT_EXCEEDED antes de escrita. Resultado original, inbox, rejeição/outbox ficam atômicos. I `audit-regressions.test.ts:58,76,90,106` verifica entrada imediata, replay após débito, resolução ansiosa, worker/claim repetido e teto exato; banco real e I1–I8 em todos. | CORRIGIDO |
| A02 | ALTA | `src/interface/http/http-problem.ts:86`; `src/infrastructure/logging/json-logger.ts:37`; `src/interface/sqs/wager-consumer.ts:198,223,236` | Stack/message arbitrários eram registrados. Erro real 22P02 incluiu JSON financeiro na mensagem, mesmo com SQL parametrizado; erro de validação/SDK também pode ecoar entrada (§12). | `errorText` permite só códigos de aplicação/domínio, SQLSTATE restrito ou UNEXPECTED_ERROR. Não serializa message/stack/cause/detail/objetos. Filtro HTTP usa JsonLogger e categoria; todos os caminhos existentes do consumer/DLQ usam o mesmo sanitizador. U `error-logging.test.ts:9,18` verifica sentinelas, formato JSON e resposta 500; I `audit-regressions.test.ts:116` provoca erro PostgreSQL verdadeiro que contém sentinela e exige diagnóstico seguro. | CORRIGIDO |
| A03 | MÉDIA | `src/infrastructure/persistence/sql-background-store.ts:19`; `src/infrastructure/workers/outbox-publisher.ts:15`; D18 | D18 prometia chegada ordenada por wallet; UPDATE RETURNING não ordena resultados e publishers podem assumir eventos da mesma wallet em ordens diferentes. FIFO ordena envios. §11 exige at-least-once, não ordem de commit. | D23 corrige explicitamente a promessa: dedupe por eventId, projeção de saldo por walletVersion, detectar lacunas quando necessário. Não foi implantada ordenação persistente adicional. Testes atuais comparam conjuntos, não sequência. | LIMITAÇÃO DOCUMENTADA |
| A04 | BAIXA | `src/domain/ledger-entry.ts:40`; `src/domain/events/integration-event.ts:51` | Object.freeze não protege o estado interno de Date. Chamador pode alterar data com setTime; nenhum caminho atual de produção observado faz isso (§6.4). | Pendente copiar instantes nas fronteiras ou representá-los como valor imutável. Sem mudança nesta fase. | PENDENTE |

Hipótese descartada: a primeira inspeção suspeitou que `$` aceitaria LF final em
Money. Execução direta no Bun 1.4.4 rejeitou tanto amount `"1.00\n"` como currency
`"BRL\n"`; `test/unit/domain/money.test.ts:48` já cobre amount com LF. O test-skeptic
confirmou e o invariant-auditor retirou o achado. Nenhuma regex alterada.

Decisões financeiras e de logs: D23 [autopilot]. Nenhuma constraint, trigger, timeout,
backoff de teste ou proteção de concorrência foi retirada ou afrouxada.

## Evidência VERMELHO → VERDE

Comando inicial, antes das correções de produção:
`bun test test/unit/error-logging.test.ts test/integration/audit-regressions.test.ts`.
Saída: **1 pass / 6 fail / 15 expect**, exit 1.

- Três testes financeiros falharam com `InvalidMoneyError: amount exceeds NUMERIC(20,2) capacity`,
  respectivamente em entrada, resolução ansiosa e worker.
- Erro PG real: esperado `DATABASE_ERROR:22P02`, recebido
  `error: SELECT $1::numeric - invalid input syntax for type numeric:` seguido do JSON
  sentinela financeiro. O unitário do sanitizador também recebeu a sentinela bruta.
- O filtro HTTP escreveu stack bruta no logger Nest em vez do JSON seguro exigido.
- O controle de crédito exatamente no teto já passou antes da mudança.

Primeira reexecução após proteção: 6 pass / 1 fail. O helper NOVO de histórico de
eventos esperava somente Rejected no caminho ansioso, esquecendo PendingReference
exigido por §11. Corrigida a preparação do teste para exigir igualdade com o histórico
completo `[WagerTransactionPendingReference, WagerTransactionRejected]`, com ordenação
explícita da consulta; preservadas as asserções de rejeição, saldo e ledger. Nenhum
teste preexistente foi editado. Resultado final direcionado: **7 pass / 0 fail / 44 expect**.

`/prove-red`: lido `.claude/commands/prove-red.md`; tentativa de worktree isolado:
`git -c safe.directory=C:/Users/nobuyasu/jungle-kit worktree add .scratch/prove-red-phase08 -b prove-red-phase08 HEAD`.
Falhou: `cannot lock ref ... .git/refs/heads/prove-red-phase08.lock: Permission denied`.
Nenhuma sabotagem aplicada à árvore principal. O vermelho natural anterior à correção
é evidência TDD; NÃO substitui a sabotagem isolada pendente das linhas 31/32 da matriz.

## Test-skeptic — lacunas remanescentes

| ID | Severidade | Evidência | Limite da prova / ação pendente |
|---|---|---|---|
| T01 | MÉDIA | C `out-of-order-reference.test.ts:34,74,102`; I `background-workers.test.ts:280` | Os casos distribuídos podem passar pela resolução ansiosa sem worker aplicar referência disponível. O teste novo I `audit-regressions:90` força referência confirmada + pendência e prova terminalização pelo resolver para rejeição; ainda falta prova distribuída específica de aplicação financeira agendada. |
| T02 | MÉDIA | C `outbox-publishers.test.ts:92`; I `background-workers.test.ts:121` | Dois PIDs/donos provam distribuição, mas não sobreposição temporal dos claims. Componente prova pular linha bloqueada e fencing; não substitui sobreposição entre processos. Retirar só SKIP LOCKED pode manter testes verdes serializando claims. Sabotagens das linhas 14/17 continuam pendentes. |
| T03 | MÉDIA | C `multi-instance.test.ts:64`; C `restart-consistency.test.ts:65`; `test/support/cluster.ts:30` | Pool agregado 75 < 252 requisições do misto e < 120 do reinício. Há mais de 50 backends bloqueados, provando participação simultânea dos três processos, mas não uma conexão para toda requisição da largada, como manda a regra literal do projeto. |
| T04 | MÉDIA | I `wagering-api.test.ts:66,143`; I `health.test.ts:39`; I `migrations.test.ts:104`; I `stack.test.ts`; I `sqs-emulator.test.ts` | Alguns casos 400/wallet ausente e os de infraestrutura não terminam com assertGlobalInvariants. Casos financeiros principais conferem banco; novos casos da auditoria sempre conferem I1–I8. Não alterada aceitação. |
| T05 | BAIXA | `test/support/cluster.ts:78` | Falha parcial ao iniciar processos em paralelo pode deixar processo iniciado antes de popular slots fora da limpeza. Sem evidência de efeito financeiro. |
| T06 | BAIXA | C `multi-instance.test.ts:96`; C `restart-consistency.test.ts:122` | Valores esperados usam number com inteiros pequenos exatos. Não há esse caminho no código monetário de produção, mas os testes poderiam seguir Money. |

### Revisão por arquivo

| Arquivo | Garantias e limites verificados |
|---|---|
| A `schema-guarantees.test.ts:63` | 22 ataques com PG real, SQLSTATE/constraint/momento corretos, invariantes; lost update intercala duas conexões deterministicamente. |
| A `wagering-http.test.ts:108` | Processo real, pool 60, barreira e backends em lock; abertura/duplicata/duas criações, duas BETs, BET 50×, keys distintas, LOSS/rejeição e replay tardio; banco e invariantes. |
| I `wagering-api.test.ts:44` | Processo real; validação/conflito/moeda/reversão/pendência/GET com banco; lacunas T04. |
| I `sqs-consumer.test.ts:143` | PG/SQS e processos reais; inbox/entregas duplicadas/negócio/quatro venenos/retry/redrive/pausa PG/crash após commit; invariantes. |
| I `background-workers.test.ts:70` | PG/SQS reais; eager/TTL/lease/fencing/publicação/rollback/cadeias/tentativas/escopo; invariantes. Exceção no checkpoint é componente; crash real coberto em C. |
| I `migrations.test.ts:104` | up→down→up e catálogo completo igual ao gabarito; ausência de resíduo, não só histórico. T04. |
| I `health.test.ts:39`; `stack.test.ts:38` | Dependências reais; apps no mesmo processo são adequados ao escopo health e não alegam multi-instância financeira. T04. |
| I `sqs-emulator.test.ts:38` | Topologia/FIFO/grupo/dedupe/redrive no emulador real; filas descartáveis. Não substitui idempotência financeira. T04. |
| I `audit-regressions.test.ts:58` | PG real e migrations de produção em banco isolado; overflow/replay/inbox/eager/worker/limite exato e erro de driver; todos I1–I8. |
| C `http-races.test.ts:42` | 3 PIDs, BET 50×, cenário §8 e 29 wallets terminando com outra travada; barreira/pg_stat_activity/banco/invariantes. |
| C `multi-instance.test.ts:46` | 3 PIDs, >50 backends em lock, carga duplicada e resultados originais; T03. |
| C `crash-after-commit.test.ts:61` | SIGKILL real nos checkpoints; before-commit zero efeito, after-commit replay; SQS exige mensagem ainda na fila antes de reiniciar e efeito único depois. |
| C `outbox-publishers.test.ts:92` | Dois donos, todos eventIds recebidos e recuperação nos dois crashes; T02. |
| C `out-of-order-reference.test.ts:34` | 10 rodadas, referência fora de ordem e reversão única; banco/invariantes; T01. |
| C `restart-consistency.test.ts:48` | Mata 3 processos com operações no banco, novos PIDs, reenvia e compara resultados originais/efeitos; T03. |

Nenhum mock de PG/SQS, pg-mem, mock.module, .skip/.only/.todo ou expect(true)
encontrado nas suítes reais. Falsos observados ficam em unit. Polling de estado,
barreiras e prazos de redelivery/lease têm condição verificável; não detectado sleep
adicionado para esconder race. Não foram alterados timeouts ou retry dos testes.

### Cobertura §13 e cinco sabotagens críticas (avaliação por leitura)

- Unidade: Money/Wallet/cinco operações/moeda/hash divergente em `test/unit/domain/*`
  e `test/unit/application/*`. Integração: migrations/constraints (I migrations + A schema),
  atomicidade (I background-workers:225 + crash), inbox/redelivery/retry/DLQ (I sqs-consumer),
  publishers (I background + C outbox), reinício (C restart/crash).
- C1–C3: `http-races:42,71,112`; C4: `multi-instance:46`; C5: `crash-after-commit:113`;
  C6: `outbox-publishers:92`; C7: `out-of-order-reference:34`; C8: `restart-consistency:48`.
  Nenhum item AUSENTE; as limitações T01–T04 impedem tratar cobertura nominal como prova completa.

| Teste crítico | Sabotagem mínima | Por que deveria reprovar |
|---|---|---|
| C `http-races:71` / A `wagering-http:192` | Retirar FOR UPDATE | Disputa imposta faz UPDATE condicionado falhar e quebra `[200,422]`. |
| A `wagering-http:298` | Retirar busca e UNIQUE da key | Camada provider/external produz conflitos em vez de 49 replays; retirando ambas as camadas, duplica. |
| C `crash-after-commit:113` / I `sqs-consumer:309` | DeleteMessage antes do checkpoint | Após morte queueDepth não seria 1; falta redelivery. |
| C `outbox-publishers:131` | Marcar publicado antes de enviar | Morte deixa linhas marcadas sem todos eventIds recebidos. |
| C `restart-consistency:48` | Replay com saldo atual | Comparação com respostas anteriores ao crash falha após novas apostas. |

Estas cinco sabotagens foram avaliadas por leitura nesta fase; não foram executadas.
Histórico de fases anteriores não é nova comprovação. Worktree continua bloqueado.

## Portão final

Todos os comandos foram executados/tentados pelo agente principal após as correções.
Saídas completas dos comandos principais em `.scratch/phase08-gate/*.log` (arquivos
locais ignorados pelo git); resumos abaixo, também registrados em `PROGRESS.md`.

| Comando | Exit / saída final |
|---|---|
| `docker compose up -d --wait` | **1**: `permission denied ... npipe:////./pipe/dockerDesktopLinuxEngine`. Dependências já acessíveis não comprovam este comando. |
| `bun run scripts/scan-forbidden.ts` | **1**: `EPERM: operation not permitted, uv_spawn 'git'` em scripts/scan-forbidden.ts:11. |
| `bun run typecheck` | **0**: `bun install` sem mudanças; `tsc --noEmit -p tsconfig.json`, sem erros. |
| `bun run test:unit` | **1**: **282 pass / 1 fail / 564 expect**, 283 testes/14 arquivos. Única falha: FaultInjector tenta `Bun.spawn` real, recebe EPERM; não chegou a testar o SIGKILL. Os dois novos unitários passaram. |
| `bun run verify:schema` | **0**: `TUDO OK`; ataques SQLSTATE corretos, cenários de concorrência e I1–I8 vazias. É o verificador de referência; o catálogo da migration é conferido separadamente na integração. |
| `bun run test:acceptance` | **1**: **22 pass / 1 fail / 90 expect**. Schema passou; setup HTTP falha em app-process.ts:94 (`Bun.spawn`, EPERM). |
| `bun run test:integration` | **1**: **31 pass / 2 fail / 167 expect**. Cinco novos casos de integração passaram, assim como os 11 de background-workers, catálogo/round-trip e infra real. Setup do consumer e da API não cria processo Bun (EPERM). |
| `for i in 1 2 3; do bun run test:concurrency || exit 1; done` | Equivalente PowerShell com a mesma interrupção na primeira falha: **1**, primeira rodada **0 pass / 10 fail**, todas em criação de processos (`Bun.spawn`, EPERM). Rodadas 2/3 não executadas, conforme `exit 1`; não há três rodadas verdes. |
| `test -s docs/AUDITORIA.md` | Tentativa literal por Git Bash: **256**, `CreateFileMapping ... Win32 error 5`, antes do builtin. Equivalente PowerShell `Get-Item` + Length > 0: **0**, arquivo não vazio (12.830 bytes antes de adicionar esta tabela). |
| Extra: `bun run lint` | **0**: `Checked 101 files ... No fixes applied.` |
| Extra: regras do scan via Bun.Glob + checkText | **0**: 96 arquivos src/test, nenhuma violação; inclui novos arquivos não versionados. NÃO substitui o scan oficial que falhou. |
| Extra: `git diff --check` e diff nos caminhos congelados | **0**; nenhum problema de whitespace e diff vazio nos caminhos congelados. |

O shell também apresentou falhas intermitentes de criação (`CreateProcessAsUserW failed: 5`);
comandos que não chegaram a iniciar foram repetidos quando o terminal voltou. Não
foram trocados os testes de processo/crash por mocks nem contornadas permissões.

## Veredito

Nenhuma ELIMINATÓRIA nova confirmada; duas ALTA de produção corrigidas e revisadas.
Reprovaria a entrega enquanto o portão obrigatório não estiver integralmente verde:
revisão e testes direcionados não substituem processos/crashes reais e três rodadas
verdes de concorrência. Lacunas MÉDIAS/BAIXAS permanecem explicitadas acima.
