---
description: Verificação completa de portão — typecheck, lint, todas as suítes, schema e invariantes — e commit se tudo verde
---

1. `docker compose up -d --wait`
2. Rode, MOSTRANDO a saída real de cada um (não resuma): `bun run typecheck`,
   `bun run lint`, `bun test test/unit`, `bun run test:integration`,
   `bun run test:concurrency`, `bun run verify:schema` (se existir).
3. Rode `bun run test:concurrency` mais duas vezes. Qualquer falha intermitente é bug:
   investigue a causa, não reexecute até passar.
4. Confira `git diff --stat` contra o último commit: nenhum arquivo de `test/acceptance/`,
   `reference/` ou `docs/CHALLENGE.md` alterado, nenhum `.skip/.only`.
5. Atualize `docs/PROGRESS.md` (portões verdes, pendências, próxima ação) e as colunas
   preenchidas de `docs/INVARIANTES.md`.
6. Se tudo verde: commit com mensagem que nomeie a garantia entregue. Se algo vermelho:
   NÃO commite; liste o que falhou e a hipótese de causa.
