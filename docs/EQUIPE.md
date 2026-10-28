# Equipe: uma caneta, vários olhos

**Tudo aqui é opcional.** O plano funciona só com o Claude Code + GitHub. Use cada outra
ferramenta apenas quando ela resolver um problema concreto: Codex para uma régua
independente ou segunda auditoria; Gemini quando travar em documentação ou para ensaiar
a banca; Copilot como autocomplete no editor.

Regra de ouro: **só o Claude Code escreve no caminho crítico** (`src/`, `migrations/`).
Os outros escrevem em ramos próprios e só em territórios separados, ou apenas leem e
criticam. Dois agentes editando o mesmo use case custam mais tempo do que economizam.

| Ferramenta | Papel | Escreve onde | Quando |
|---|---|---|---|
| **Claude Code** | Implementador do núcleo | `src/`, `migrations/`, `test/integration`, `test/concurrency` | Dias 1–3 |
| **Codex (GPT Plus)** | Autor da régua + 2º auditor | `test/acceptance/` (ramo `acceptance`) | S2 (Dia 1) e S8 (Dia 3) |
| **Gemini Pro** | Pesquisa de documentação (com busca) + leitor do repositório inteiro + banca simulada | nada | spike (S1), portões dos Dias 2 e 3, ensaio |
| **Copilot Pro** | Autocomplete no editor + revisão de PR | o que você digitar | o tempo todo; revisão nos portões |
| **GitHub Pro** | Árbitro neutro: CI com Postgres e SQS reais + ramo `main` protegido | `.github/workflows/ci.yml` | a cada push, desde o fim do spike |

O Codex lê `AGENTS.md`, que no kit é um link simbólico para `CLAUDE.md`: as mesmas regras
valem para os dois. Os hooks só existem no Claude Code; para o resto, o CI do GitHub roda
`scripts/scan-forbidden.ts` com as MESMAS regras (`.claude/hooks/rules.ts`) sobre todo o
repositório — vale para código de qualquer IA ou seu.

---

## Prompts prontos

### Codex — S2: escrever a régua (ramo `acceptance`)

```bash
git switch -c acceptance
codex
```

- `git switch -c acceptance` cria (`-c`, *create*) o ramo `acceptance` e muda para ele.
- `codex` abre a CLI do Codex na pasta.

> Leia AGENTS.md, docs/CHALLENGE.md §6–§13, docs/INVARIANTES.md e
> reference/verify-schema.ts. Escreva SOMENTE testes em test/acceptance/ e o suporte em
> test/support/ (banco isolado por arquivo via CREATE DATABASE … TEMPLATE, cliente
> HTTP, barreira de largada, assertGlobalInvariants executando
> reference/sql/invariants.sql). Cubra as linhas 1, 2, 3, 7, 8, 19, 24 e 26 da matriz,
> o cenário obrigatório da §8 e a mesma BET 50× em paralelo via HTTP. Cada teste confere
> o BANCO. Pool ≥ paralelismo. Nada de mock. Não implemente código de produção; os
> testes devem falhar agora pelo motivo certo. Não altere nada fora de test/.

Revise, faça o commit, depois `git switch main && git merge acceptance` (`switch main`
volta ao ramo principal; `merge acceptance` traz os testes para ele). A partir daí o
hook do Claude congela `test/acceptance/`.

### Codex — S8: segunda auditoria (Dia 3, contexto limpo)

> Leia .claude/agents/invariant-auditor.md e execute aquela auditoria sobre este
> repositório. Somente leitura: não edite arquivos. Entregue a tabela de achados.

Depois, em outra conversa: o mesmo com `.claude/agents/test-skeptic.md`. Leve os achados
dos dois auditores (Claude e Codex) para uma sessão do Claude Code e corrija um por commit.

### Gemini — perguntas do spike (S1)

Use quando o Claude travar em integração de ferramentas. Peça respostas com links da
documentação oficial e cole o resultado no Claude.

- MikroORM 6 com Bun 1.x: o CLI de migrations funciona? Como rodar o Migrator programaticamente?
- NestJS sob Bun: `emitDecoratorMetadata` funciona? Quais problemas conhecidos?
- LocalStack desde 23/03/2026 exige conta e auth token na imagem atual: como gerar um
  token gratuito para uso local e para CI? Ou o MiniStack (MIT, sem token) suporta filas
  FIFO e RedrivePolicy (maxReceiveCount) do SQS?
- `@aws-sdk/client-sqs` contra LocalStack: endpoint, região e credenciais de teste.

### Gemini — leitura total do repositório (portões dos Dias 2 e 3)

Gere um arquivo único com o código e envie ao Gemini (contexto longo):

```bash
git ls-files -z | xargs -0 tail -n +1 > /tmp/repo.txt
```

- `git ls-files` lista os arquivos versionados; `-z` separa os nomes por um caractere
  nulo (seguro para nomes com espaço).
- `|` passa a lista adiante; `xargs -0` lê essa lista separada por nulo e a entrega como
  argumentos ao comando seguinte.
- `tail -n +1` imprime cada arquivo **a partir da linha 1** (inteiro) com um cabeçalho
  `==> nome <==`, o que deixa claro onde cada arquivo começa.
- `>` grava tudo em `/tmp/repo.txt`.

> Anexei um repositório inteiro e o enunciado (docs/CHALLENGE.md). Para cada requisito
> obrigatório e cada falha eliminatória do enunciado, diga onde está atendido
> (arquivo:linha) ou que está AUSENTE. Depois aponte incoerências entre ARCHITECTURE.md
> e o código. Não elogie; liste só lacunas e riscos.

### Gemini Live — ensaio oral (Dia 3, noite)

Por voz, sem olhar o código:

> Você é o avaliador técnico da Jungle Gaming. Fiz um processador de apostas com NestJS,
> PostgreSQL, SQS, outbox e inbox. Faça-me perguntas difíceis, uma de cada vez, sobre
> concorrência, idempotência, crash entre commit e ack, e minhas interpretações do
> enunciado. Interrompa quando eu enrolar.

### Copilot

- No VS Code: autocomplete enquanto você lê e ajusta (não consome créditos nos planos pagos).
- Abra um PR por portão (fim de cada dia) e peça a revisão do Copilot no GitHub: um
  terceiro par de olhos, barato, nos diffs maiores. Os créditos (≈ US$ 15/mês) são
  curtos; não use o agente dele para escrever código aqui.

### GitHub Pro — o árbitro (configure ao fim do spike)

1. Crie o repositório **privado** e faça o primeiro push.
2. Se ficar com o LocalStack: Settings → Secrets and variables → Actions → New
   repository secret `LOCALSTACK_AUTH_TOKEN`. Se ficar com o MiniStack, troque a
   imagem e o health check em `.github/workflows/ci.yml` (instruções no topo do arquivo).
3. Settings → Branches → Add rule para `main`: *Require a pull request before merging* e
   *Require status checks to pass* → marque `ci`. Proteção de ramo em repositório
   privado é justamente o que o Pro libera.
4. Daí em diante: cada fase num ramo, PR, CI verde, merge. Nenhuma IA consegue
   "convencer" o CI: ele roda os testes com Postgres e SQS reais, três vezes a suíte de
   concorrência, o round-trip das migrations e a varredura de código proibido.
5. Antes de entregar, dê acesso de leitura aos avaliadores (ou torne público, se o
   processo pedir) — o histórico de CI verde vira evidência na banca.
