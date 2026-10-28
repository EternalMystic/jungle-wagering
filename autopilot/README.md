# Autopilot — o projeto andando sozinho, Claude primeiro, Codex na reserva

# Modo "fui embora" (recomendado para deixar horas rodando)

```bash
bash scripts/run-unattended.sh
```

Confere pré-requisitos e logins, cria o repositório git se preciso, impede o computador
de dormir (macOS: `caffeinate`; Linux: `systemd-inhibit`), e roda o autopilot com
`--unattended` dentro de um cão de guarda que o reinicia se cair por erro inesperado.
Diferenças do modo normal:

- não para depois da fase 02: os testes de aceitação são revisados pelo OUTRO agente
  (fase 02r, relatório em `docs/REVISAO-ACEITACAO.md`); se ele estiver sem cota, espera
  até 90 min para não ter o autor revisando a própria régua;
- até 6 tentativas por fase, alternando Claude e Codex depois de cada falha;
- o horário de reset da cota é lido da mensagem de erro quando possível; senão, nova
  tentativa a cada 30 min.

Parar: `bash scripts/run-unattended.sh --stop` · Resumo: `bash scripts/run-unattended.sh --status`

Opcional, para acompanhar pelo celular:
- `AUTOPILOT_NTFY=um-nome-secreto-qualquer bash scripts/run-unattended.sh` e instale o app
  **ntfy** no celular, assinando o mesmo nome: chega um aviso a cada fase. O nome do
  tópico funciona como senha (quem souber o nome lê as mensagens), então invente um longo.
- `AUTOPILOT_PUSH=1` faz `git push` para o ramo `autopilot` a cada fase (precisa de um
  `origin` configurado): dá para ver os commits no app do GitHub.

---


## Como funciona

```
fase → agente (Claude; se sem cota, Codex) → orquestrador roda o PORTÃO → verde? commit : nova tentativa
```

- **Quem decide que a fase acabou é o portão, não o agente.** O orquestrador roda
  sozinho os testes reais (Postgres, SQS, varredura de código proibido, typecheck).
- **Cota esgotada:** o agente entra em espera (60 min por padrão) e o outro assume a
  mesma fase, lendo `docs/PROGRESS.md`. Quando o Claude volta a ter cota, ele retoma.
  Se os dois estiverem sem cota, o script dorme e continua sozinho depois.
- **Régua intocável:** se um agente mexer em `test/acceptance/`, `reference/` ou
  `docs/CHALLENGE.md`, a alteração é revertida e a tentativa é reprovada. Isso vale
  também para o Codex, que não tem os hooks do Claude.
- **Paradas para você** (só duas situações):
  1. depois da fase 02, para revisar os testes de aceitação (`autopilot/REVISAR.md`);
  2. se uma fase falhar 3 vezes seguidas (`autopilot/BLOQUEADO.md`).

## Uso

```bash
bun run scripts/autopilot.ts
```
- `bun run` executa o arquivo TypeScript; sem argumentos, continua da próxima fase pendente.

```bash
bun run scripts/autopilot.ts --approve 02
```
- `--approve 02` registra que você revisou a fase 02 e segue em frente.

```bash
bun run scripts/autopilot.ts --status
```
- `--status` mostra fases concluídas, aprovadas e agentes em espera, e sai.

Outras opções:
- `--only 04` roda só a fase 04 (útil depois de destravar uma fase à mão).
- `--start codex` faz o Codex ser o agente principal, e o Claude a reserva.

Para deixar rodando e poder fechar o terminal:

```bash
nohup bun run scripts/autopilot.ts > autopilot/run.out 2>&1 &
tail -f autopilot/autopilot.log
```
- `nohup` mantém o processo vivo mesmo se o terminal fechar (*no hang-up*).
- `> autopilot/run.out` manda a saída normal para esse arquivo; `2>&1` junta os erros
  (canal 2) na mesma saída (canal 1).
- `&` no fim roda em segundo plano e devolve o terminal.
- `tail -f` mostra as linhas novas do log à medida que chegam (`-f`, *follow*);
  `Ctrl+C` para de acompanhar sem parar o autopilot.

## Variáveis de ambiente

| Variável | Padrão | Efeito |
|---|---|---|
| `AUTOPILOT_COOLDOWN_MIN` | 60 | minutos de espera após um agente esgotar a cota |
| `AUTOPILOT_TIMEOUT_MIN` | 120 | tempo máximo de uma execução de agente |
| `AUTOPILOT_MAX_ATTEMPTS` | 3 | tentativas por fase antes de parar |
| `AUTOPILOT_YOLO` | — | `1` = agentes sem nenhuma pergunta de permissão. **Só em VM ou container** |

Exemplo: `AUTOPILOT_COOLDOWN_MIN=30 bun run scripts/autopilot.ts` (a variável vale só
para esse comando).

## Permissões: o ponto que mais trava execução sem supervisão

- **Claude** roda com `--permission-mode acceptEdits` e a lista `allow` de
  `.claude/settings.json`. Comando fora da lista é negado (não há quem aprove), e o
  agente precisa contornar. Se travar nisso, aumente a lista.
- **Codex** roda com `--full-auto` e rede liberada no sandbox. Se o sandbox impedir o
  `docker compose` ou os testes, as saídas são duas: rodar o Codex só nas fases que não
  dependem disso, ou rodar tudo com `AUTOPILOT_YOLO=1` dentro de uma VM ou container.
  Nunca use YOLO na sua máquina principal.
- Os hooks do Claude continuam valendo no modo sem supervisão. O CI do GitHub e a
  reversão de arquivos congelados cobrem o Codex.

## Logs

- `autopilot/autopilot.log` — linha do tempo.
- `autopilot/logs/fase-NN-tentativa-K-<agente>.log` — tudo o que o agente disse.
- `autopilot/logs/fase-NN-tentativa-K-portao.log` — o que o orquestrador verificou.

## O que o autopilot NÃO faz por você

- Não revisa a régua (fase 02). Isso é seu.
- Não te prepara para a banca. Leia o diff de cada commit `autopilot: fase NN`,
  principalmente a migration e o `ProcessWagerTransaction`.
- Não substitui o push: ao fim de cada dia, `git push` e confira o CI verde no GitHub.
