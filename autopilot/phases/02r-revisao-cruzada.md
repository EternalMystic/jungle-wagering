FASE 02r — Revisão cruzada da régua (o humano está ausente; você é o revisor dele).
Outro modelo escreveu test/acceptance/ e test/support/ na fase 02. Seu trabalho é
desconfiar deles, seguindo o checklist de .claude/agents/test-skeptic.md:

1. O paralelismo é real (pool ≥ paralelismo, barreira de largada, conexões distintas)?
2. Cada teste confere o BANCO (saldo, nº de lançamentos, status, outbox) e termina com
   assertGlobalInvariants? Ou só olha o status HTTP?
3. Há mock, stub, atalho que pula o use case, sleep arbitrário ou timeout inflado?
4. Estão cobertos: linhas 1, 2, 3, 7, 8, 19, 24 e 26 de docs/INVARIANTES.md, o cenário
   obrigatório da §8 e a mesma BET 50× em paralelo?
5. Para os 5 testes mais críticos: qual sabotagem mínima no código de produção deveria
   deixá-los vermelhos? Lendo o teste, ele ficaria?

Corrija e FORTALEÇA os testes onde houver falha (você pode editar test/acceptance/ e
test/support/ nesta fase). Não afrouxe nada que já esteja correto. Não implemente
código de produção: os testes devem continuar FALHANDO por ausência de implementação.
Escreva docs/REVISAO-ACEITACAO.md com: cada achado, o que você mudou e o que ficou para
o humano decidir.
