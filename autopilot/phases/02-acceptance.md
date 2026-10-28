FASE 02 — Testes de aceitação (a régua). ESTA é a única fase em que você escreve em
test/acceptance/.
Leia docs/CHALLENGE.md §6–§13, docs/INVARIANTES.md e reference/verify-schema.ts.
Escreva SOMENTE testes em test/acceptance/ e suporte em test/support/, cobrindo as
linhas 1, 2, 3, 7, 8, 19, 24 e 26 da matriz, o cenário obrigatório da §8 e a mesma
BET 50× em paralelo via HTTP. test/support/: banco isolado por arquivo (CREATE DATABASE
… TEMPLATE), subida da aplicação, cliente HTTP, barreira de largada para paralelismo
real, assertGlobalInvariants(db) executando reference/sql/invariants.sql. Pool ≥
paralelismo. Cada teste confere o BANCO. Nada de mock. Não implemente produção: os
testes devem FALHAR agora por ausência de implementação (não por erro de sintaxe ou
de tipos). Liste no docs/PROGRESS.md cada teste e a garantia que ele prova.
