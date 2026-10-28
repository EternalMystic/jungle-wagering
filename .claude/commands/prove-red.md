---
description: Sabota uma garantia num worktree descartável e prova que o teste correspondente fica VERMELHO
argument-hint: <linha da matriz ou nome da garantia, ex. "2" ou "section-8">
---

Garantia a provar: $ARGUMENTS

1. Localize a linha correspondente em `docs/INVARIANTES.md` (coluna "Sabotagem") e o
   teste da coluna "Prova".
2. Crie um worktree descartável: `git worktree add ../prove-red-tmp -b prove-red-tmp HEAD`.
3. NO WORKTREE, aplique a menor sabotagem possível no código de produção ou na
   migration (nunca no teste). Mostre o diff.
4. Rode SOMENTE o(s) teste(s) da garantia no worktree, com banco/filas isolados.
5. Resultado esperado: VERMELHO, falhando pelo motivo certo (mostre a asserção que caiu).
   - Se ficou VERDE: o teste não protege a garantia. Explique por quê e proponha como
     fortalecê-lo (não altere `test/acceptance/**`; relate ao humano).
6. Remova o worktree: `git worktree remove --force ../prove-red-tmp && git branch -D prove-red-tmp`.
7. Registre em `docs/PROGRESS.md`, seção "Sabotagens comprovadas": garantia, sabotagem,
   teste, resultado. Confirme que a árvore principal está intacta (`git status`).
