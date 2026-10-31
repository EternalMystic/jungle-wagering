# Gabarito do schema

- `sql/001_schema.sql` / `sql/001_schema.down.sql` — schema completo e seu reverso
  (round-trip up → down → up → down testado em PostgreSQL 16.15).
- `sql/invariants.sql` — consultas I1–I8; todas vazias = sistema consistente.
- `verify-schema.ts` — prova executável: 19 ataques por SQL cru que o banco recusa,
  a sabotagem read→calculate→update barrada, o cenário da §8, 50 BETs idênticas em
  paralelo e 20 wallets em paralelo, terminando com I1–I8.

`bun run verify:schema` executa `scripts/verify-schema.ts`, que aponta o verificador
para o `DATABASE_URL` do projeto (padrão: o Postgres do Compose na porta 55432). O
verificador cria um banco descartável (`wagering_verify_<timestamp>`), roda as provas
e o apaga. A saída esperada termina em `TUDO OK`.

A migration de produção (`migrations/Migration20261028000000_initial.ts`) aplica este
mesmo SQL; `test/integration/migrations.test.ts` confere que o catálogo migrado é igual
ao do gabarito aplicado cru.
