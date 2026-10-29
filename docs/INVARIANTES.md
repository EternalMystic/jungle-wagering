# Matriz de rastreabilidade: exigência → garantia → prova → sabotagem

Regra: uma linha só está "verde" quando as QUATRO colunas existem. A coluna
"Sabotagem" é o que separa "passou no teste" de "a propriedade existe": remova a
proteção num worktree descartável (`/prove-red`) e o teste PRECISA ficar vermelho.
Se não ficar, o teste é decorativo.

Legenda de teste: `A` = test/acceptance (congelado) · `I` = integration · `C` = concurrency · `U` = unit.

| # | Exigência (README) | Garantia (onde mora) | Prova (teste) | Sabotagem que deve deixar vermelho |
|---|---|---|---|---|
| 1 | Saldo nunca negativo (§3, §6.2) | `CHECK balance_amount >= 0`; update condicionado; lock | A `schema: negative balance rejected`; C `section-8 race` | remover `FOR UPDATE` **e** o `>= $x` do UPDATE |
| 2 | Sem lost update (§6.2, §5.7) | `FOR UPDATE`; `version`; `uq_ledger_wallet_version`; trigger diferido | C `two 80 bets on 100` | trocar `FOR UPDATE` por SELECT simples |
| 3 | Débito/crédito nunca duplicado | `UNIQUE idempotency_key`, `UNIQUE (provider, external)`, `UNIQUE (wallet, transaction)` no ledger | C `same bet 50x in parallel` | remover a busca por key **e** o UNIQUE (só em worktree) |
| 4 | Idempotência persistente (§5.2) | tabelas, não memória | C `restart-consistency` (SIGKILL em 3 processos, processos novos, reenvio = replay original) | trocar por Map em memória → reenvio pós-restart duplica |
| 5 | Mesma key + payload diferente = conflito (§6.3, §9) | `payload_hash` + comparação | U `hash mismatch`; I `409 on divergent payload` | comparar só a key |
| 6 | Replay devolve resultado original com saldo da época (§7.7) | `result_balance_amount` congelado | I `replay returns original balance after later bets` | responder com saldo atual |
| 7 | Toda mudança de saldo ⇔ lançamento (§6.2) | constraint triggers diferidos | A `schema: balance change without entry rejected`, `orphan entry rejected` | desabilitar o trigger → teste A vermelho |
| 8 | Ledger imutável (§5.5) | triggers `BEFORE UPDATE/DELETE/TRUNCATE` (+ GRANT opcional) | A `schema: ledger append-only` | dropar trigger |
| 9 | Atomicidade wallet/ledger/inbox/outbox (§6.5, §11) | uma `em.transactional`; FaultInjector `before-commit` | C `crash-after-commit` › HTTP before-commit (SIGKILL real, nada confirmado); U FaultInjector; invariantes I6/I7 | inserir outbox fora da transação |
| 10 | Evento só depois do commit (§5.4) | publisher lê só outbox commitada | I `no event visible before commit` | publicar direto no use case |
| 11 | Ack só após commit (§10) | consumer: commit → `after-commit-before-ack` → delete | C `crash-after-commit` › SQS (verde); I `sqs-consumer` › SIGKILL em after-commit-before-ack; U drain | `DeleteMessage` antes do commit → I vermelho (`queueDepth` 0 ≠ 1), provado na fase 06 |
| 12 | Redelivery sem duplicar (§10) | inbox PK `(consumer, message_id)` na transação do efeito | I `redelivery 3×`; U inbox (replay original, outra key, payload divergente) | remover inbox (D4 ainda segura o débito; a inbox dá o ack silencioso e detecta messageId com outro payload — D21) |
| 13 | Erros: negócio/transitório/permanente (§10) | `retry-policy.ts` + visibility backoff + DLQ explícita + redrive | I `permanente → DLQ` (4 motivos, 1º recebimento), `lock preso → 5 recebimentos → DLQ`, `Postgres pausado → retry → recupera`, `negócio → ack`; U classificação | tratar tudo como transitório |
| 14 | Publishers concorrentes (§11) | `SqlBackgroundStore`: lease + `SKIP LOCKED` + fencing | C `outbox-publishers`; I `background-workers` › disputa de claims e dono antigo; C bloqueado pelo ambiente nesta sessão | remover `SKIP LOCKED` e o lease; prova pendente |
| 15 | Crash entre commit e publish (§11) | `OutboxPublisher`: checkpoints; lease expira, outro dono publica | C `outbox-publishers` › after-claim-before-publish e after-publish-before-mark (execução bloqueada); I interrupção após envio | marcar published antes de publicar; prova pendente |
| 16 | ≥3 instâncias (§8) | tudo acima, sem estado em memória | C `multi-instance` + `http-races` (3 processos `Bun.spawn`, disputa provada no banco) | — (é o teste-mãe) |
| 17 | Referência fora de ordem (§7.1) | `ResolvePendingReferences` + claim `SKIP LOCKED` + `resolveEagerly` no mesmo commit | C `out-of-order-reference` (execução bloqueada); I `background-workers` › resolução ansiosa, cadeias e reversões | worker sem `SKIP LOCKED` em 2 instâncias; prova pendente |
| 18 | TTL de referência → REJECTED + evento (§7.1) | 8 tentativas / TTL 915 s; `REFERENCE_NOT_FOUND` + outbox atômica | I `background-workers` › backoff e TTL com clock injetado (verde na execução inicial); caso de 8 tentativas aguarda revalidação | — |
| 19 | Reversão única (§7.4) | `uq_tx_single_reversal` | A `schema: double reversal`; C `same refund 2 ids parallel` | dropar índice |
| 20 | Reversão com saldo insuficiente → código distinto (§7.9) | domínio | U `rollback of win after spending` | usar `INSUFFICIENT_FUNDS` |
| 21 | Referência no mesmo escopo (§7.2) | domínio + query por `(provider, external)` | U por campo divergente | — |
| 22 | Money exato, 2 casas, sem notação científica (§6.1) | `Money` bigint + regex | U tabela de entradas inválidas | aceitar `Number(x)` |
| 23 | Conflito de moeda (§6.1, §6.2) | `Money.assertSameCurrency`; FK composta ledger↔wallet | U; A `ledger currency ≠ wallet` | — |
| 24 | 1 wallet por player+moeda (§6.2) | `UNIQUE (player_id, currency)` | A; I `409 duplicate wallet` (inclusive 2 criações em paralelo) | — |
| 25 | OPENING interno, mesma transação (§9) | use case OpenWallet; trigger de abertura | I `open wallet atomic`; I `OPENING via API → 400` | — |
| 26 | `version` = 1 e só sobe com saldo (§6.2) | trigger diferido | A; invariante I2 | — |
| 27 | Reinício preserva consistência (§13.8) | estado só no banco | C `restart-consistency` + invariantes | — |
| 28 | Reconciliação não corrige em silêncio (§9) | endpoint lê, loga, métrica | I `divergence reported` (diverge via SQL com trigger desabilitado em teste) | — |
| 29 | Migrations reversíveis (§4) | `up`/`down` | I `migrations round-trip` | — |
| 30 | Testes sem mock de PG/SQS (§14) | lint + hook | revisão do `test-skeptic` | — |

## Invariante final de todo teste

`reference/sql/invariants.sql` (I1–I8) via `assertGlobalInvariants(db)`. Entre elas:
`wallet.balance == saldo reconstruído pelo ledger`.
