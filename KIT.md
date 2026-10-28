# Kit Claude Code — Jungle Gaming backend challenge

Copie o conteúdo desta pasta para a raiz do repositório novo (ver `docs/PLANO.md`, Dia 0).

```
CLAUDE.md                     regras que o Claude lê em toda sessão
docs/CHALLENGE.md             enunciado original (congelado)
docs/PLANO.md                 roteiro de 3 dias com prompts prontos e portões
docs/DECISOES.md              decisões técnicas e interpretações → vira ARCHITECTURE.md
docs/INVARIANTES.md           matriz exigência → garantia → teste → sabotagem
docs/PROGRESS.md              passagem de bastão entre sessões
docs/EQUIPE.md                papel de cada IA (Claude, Codex, Gemini, Copilot, GitHub) e prompts
AGENTS.md                     link para CLAUDE.md (regras lidas pelo Codex)
reference/                    schema-gabarito verificado em Postgres 16 + invariantes
.claude/settings.json         permissões + hooks
.claude/hooks/guard.ts        bloqueia atalhos (dinheiro em number, mock, .skip, ledger UPDATE…)
.claude/hooks/stop-gate.ts    não deixa "concluir" com typecheck/unit vermelhos
.claude/agents/               invariant-auditor e test-skeptic (somente leitura)
.claude/commands/             /prove-red e /checkpoint
.claude/hooks/rules.ts        regras proibidas, fonte única (hook + CI)
scripts/scan-forbidden.ts     varredura do repositório inteiro no CI
.github/workflows/ci.yml      CI com Postgres + SQS reais (árbitro neutro)
scripts/autopilot.ts          orquestrador sem supervisão: Claude primeiro, Codex na reserva
scripts/run-unattended.sh     UM comando: liga o autopilot, mantém o PC acordado e reinicia se cair
autopilot/                    prompts das 10 fases + README de uso
```

Os hooks precisam do Bun no PATH (já é requisito do desafio).
Apague este KIT.md e mova `reference/` para onde preferir antes de entregar —
ou mantenha: um gabarito de schema com prova executável é um bom argumento na banca.
