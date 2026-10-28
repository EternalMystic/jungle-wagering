# Gabarito do schema

- `sql/001_schema.sql` / `sql/001_schema.down.sql` — schema completo e seu reverso
  (round-trip up → down → up → down testado em PostgreSQL 16.15).
- `sql/invariants.sql` — consultas I1–I8; todas vazias = sistema consistente.
- `verify-schema.ts` — prova executável: 19 ataques por SQL cru que o banco recusa,
  a sabotagem read→calculate→update barrada, o cenário da §8, 50 BETs idênticas em
  paralelo e 20 wallets em paralelo, terminando com I1–I8.

No projeto, depois do spike:

```bash
bun add -d pg @types/pg
# package.json → "verify:schema": "bun run reference/verify-schema.ts"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun run verify:schema
```

- `bun add -d` instala como dependência de **desenvolvimento** (`-d`, *dev*): só para testes/ferramentas.
- `DATABASE_URL=… bun run …` define a variável de ambiente apenas para aquele comando;
  o script cria um banco descartável (`wagering_verify_<timestamp>`), testa e o apaga.

Saída esperada termina em `TUDO OK`.
