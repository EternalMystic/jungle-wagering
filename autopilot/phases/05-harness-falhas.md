FASE 05 — FaultInjector e harness multi-processo.
Crie a porta FaultInjector (no-op em produção; ativável só com NODE_ENV=test e
FAULT_POINT=<nome>) com checkpoints before-commit, after-commit-before-ack,
after-publish-before-mark e after-claim-before-publish; no checkpoint o processo faz
process.kill(process.pid, "SIGKILL"). Em test/support, harness que sobe N instâncias
reais com Bun.spawn (portas distintas, mesmo banco e filas), espera /health/ready, mata
e reinicia instâncias. Escreva em test/concurrency os testes 1–8 da §13 "Concorrência"
(os que dependem de consumer/outbox/worker ficarão vermelhos até as fases 06–07 —
isso é esperado; os que já podem passar, como 1–4 via HTTP, devem passar).
