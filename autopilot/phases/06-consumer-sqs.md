FASE 06 — Consumer SQS + inbox.
Consumer conforme D9: mesmo use case do HTTP, inbox na mesma transação, ack só após
commit, classificação negócio/transitório/permanente, visibility backoff, DLQ explícita
para permanentes, redrive como rede de segurança, SIGTERM com drain. Testes de
integração: redelivery 3×, transitório que se recupera (docker compose pause/unpause do
Postgres), permanente → DLQ, 5 recebimentos → DLQ, kill após commit e antes do ack.
