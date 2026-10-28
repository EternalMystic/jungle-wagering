FASE 08 — Auditoria e correção.
Use o subagente invariant-auditor (ou, se não houver subagentes, siga você mesmo
.claude/agents/invariant-auditor.md) e depois o test-skeptic
(.claude/agents/test-skeptic.md). Grave os achados em docs/AUDITORIA.md com
severidade. Corrija todos os ELIMINATÓRIA e ALTA no código de produção (nunca em
test/acceptance). Para cada correção, registre em docs/AUDITORIA.md o que mudou e
qual teste prova.
