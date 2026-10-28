Você está rodando SEM SUPERVISÃO, conduzido por scripts/autopilot.ts. Ninguém vai
responder perguntas. Regras desta execução:

1. Leia primeiro AGENTS.md/CLAUDE.md, docs/PROGRESS.md, docs/DECISOES.md e
   docs/INVARIANTES.md. docs/CHALLENGE.md é a especificação.
2. Faça SOMENTE a fase descrita abaixo. Não adiante fases futuras.
3. Diante de ambiguidade: escolha a opção mais segura para correção financeira,
   registre a decisão em docs/DECISOES.md (marcada [autopilot]) e continue.
4. NUNCA edite test/acceptance/**, reference/** ou docs/CHALLENGE.md (salvo na fase
   que manda escrever os testes de aceitação). O orquestrador reverte essas edições e
   conta a tentativa como falha.
5. Teste falhando = código de produção errado. Proibido afrouxar constraint, teste,
   timeout ou usar sleep para "passar".
6. Ao terminar: rode você mesmo os comandos do PORTÃO listados abaixo e mostre a saída.
   O orquestrador vai rodá-los de novo, de forma independente; só isso conta.
7. Atualize docs/PROGRESS.md (feito, pendente, decisões tomadas). Não faça git commit:
   o orquestrador commita quando o portão passa.
