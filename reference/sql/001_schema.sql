-- =============================================================================
-- Jungle Gaming — Distributed Wagering Processor
-- SCHEMA DE REFERÊNCIA (PostgreSQL 16)
--
-- Propósito: mostrar ao Claude Code (e à banca) que TODA garantia da seção 6
-- do desafio vive no banco, não só no código. A migration real do MikroORM deve
-- reproduzir isto (up) e desfazer tudo (down). Validado contra Postgres 16 pelo
-- script reference/verify-schema.ts — cada ataque listado lá precisa FALHAR.
--
-- Convenções:
--   * dinheiro = NUMERIC(20,2) — exato, escala fixa 2. Nunca float/double.
--   * moeda    = CHAR(3) maiúsculo (ISO-4217).
--   * hash     = SHA-256 hex (64 chars) do JSON canônico.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. WALLETS
-- -----------------------------------------------------------------------------
CREATE TABLE wallets (
  id              UUID          PRIMARY KEY,
  player_id       UUID          NOT NULL,
  currency        CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_amount  NUMERIC(20,2) NOT NULL CHECK (balance_amount >= 0),  -- não-negatividade NO SCHEMA
  version         INTEGER       NOT NULL CHECK (version >= 1),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),  -- 1 wallet por player+moeda
  CONSTRAINT uq_wallet_id_currency     UNIQUE (id, currency)          -- alvo de FK composta (moeda coerente)
);

-- -----------------------------------------------------------------------------
-- 2. WAGER TRANSACTIONS (também é o registro de idempotência HTTP)
-- -----------------------------------------------------------------------------
CREATE TABLE wager_transactions (
  id                                  UUID          PRIMARY KEY,
  provider_id                         TEXT          NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  external_transaction_id             TEXT          NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 256),
  idempotency_key                     TEXT          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  payload_hash                        CHAR(64)      NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  wallet_id                           UUID          NOT NULL REFERENCES wallets (id),
  player_id                           UUID          NOT NULL,
  round_id                            TEXT,
  game_id                             TEXT,
  kind                                TEXT          NOT NULL
    CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                              NUMERIC(20,2) NOT NULL CHECK (amount >= 0),
  -- a moeda da transação NÃO tem FK composta: uma transação REJECTED por
  -- CURRENCY_MISMATCH precisa ser persistida (auditável) com a moeda errada.
  currency                            CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id   TEXT,
  reference_transaction_id            UUID          REFERENCES wager_transactions (id),
  status                              TEXT          NOT NULL
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                        TEXT,
  -- "saldo observado naquele momento" — congelado para o replay idempotente
  result_balance_amount               NUMERIC(20,2) CHECK (result_balance_amount >= 0),
  correlation_id                      TEXT          NOT NULL,
  reference_attempts                  INTEGER       NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
  next_reference_attempt_at           TIMESTAMPTZ,
  created_at                          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_at                         TIMESTAMPTZ,

  CONSTRAINT uq_tx_idempotency_key   UNIQUE (idempotency_key),
  CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_tx_id_wallet_currency UNIQUE (id, wallet_id, currency),   -- alvo de FK do ledger

  -- OPENING é interno: sem rodada/jogo/referência; demais exigem rodada e jogo
  CONSTRAINT ck_tx_round_game CHECK (
    (kind = 'OPENING' AND round_id IS NULL AND game_id IS NULL)
    OR (kind <> 'OPENING' AND round_id IS NOT NULL AND game_id IS NOT NULL)
  ),
  -- REFUND/ROLLBACK exigem referência externa; os outros não podem trazer referência obrigatória
  CONSTRAINT ck_tx_reference_required CHECK (
    kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
  ),
  CONSTRAINT ck_tx_opening_no_reference CHECK (
    kind <> 'OPENING' OR reference_external_transaction_id IS NULL
  ),
  -- só LOSS pode ter valor zero (decisão documentável)
  CONSTRAINT ck_tx_amount_positive CHECK (kind = 'LOSS' OR amount > 0),
  -- terminal ⇔ resolved_at preenchido
  CONSTRAINT ck_tx_resolved_at CHECK (
    (status IN ('PROCESSED','REJECTED','FAILED')) = (resolved_at IS NOT NULL)
  ),
  -- REJECTED/FAILED ⇔ failure_code
  CONSTRAINT ck_tx_failure_code CHECK (
    (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
  ),
  -- reversão aplicada precisa estar ligada à referência interna
  CONSTRAINT ck_tx_processed_reversal_linked CHECK (
    NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL
  ),
  CONSTRAINT ck_tx_no_self_reference CHECK (reference_transaction_id IS DISTINCT FROM id),
  -- PENDING_REFERENCE sempre tem próximo horário de tentativa
  CONSTRAINT ck_tx_pending_ref_schedule CHECK (
    status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL
  ),
  -- resultado terminal (exceto FAILED) carrega o saldo observado para o replay
  CONSTRAINT ck_tx_result_balance CHECK (
    status NOT IN ('PROCESSED','REJECTED') OR result_balance_amount IS NOT NULL
  )
);

-- Regra 4 (interpretação ESTRITA, recomendada): uma transação é revertida no
-- máximo UMA vez por QUALQUER reversão. O README diz "pelo mesmo tipo", o que
-- literalmente permitiria REFUND + ROLLBACK da mesma BET = crédito duplicado
-- (eliminatório). Documente esta escolha no ARCHITECTURE.md.
-- ROLLBACK de um REFUND continua possível: ele referencia o REFUND, não a BET.
CREATE UNIQUE INDEX uq_tx_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- worker de PENDING_REFERENCE
CREATE INDEX ix_tx_pending_reference_due
  ON wager_transactions (next_reference_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- resolução ansiosa: "chegou a BET; alguém está esperando por ela?"
CREATE INDEX ix_tx_waiting_for_reference
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

-- -----------------------------------------------------------------------------
-- 3. LEDGER (append-only)
-- -----------------------------------------------------------------------------
CREATE TABLE wallet_ledger_entries (
  id               UUID          PRIMARY KEY,
  wallet_id        UUID          NOT NULL,
  transaction_id   UUID          NOT NULL,
  currency         CHAR(3)       NOT NULL,
  direction        TEXT          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount           NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  balance_before   NUMERIC(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after    NUMERIC(20,2) NOT NULL CHECK (balance_after  >= 0),
  -- versão da wallet DEPOIS deste lançamento: amarra 1 lançamento ⇔ 1 incremento de versão
  wallet_version   INTEGER       NOT NULL CHECK (wallet_version >= 1),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- a moeda do lançamento é a da wallet
  CONSTRAINT fk_ledger_wallet_currency
    FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  -- o lançamento pertence a uma transação DESTA wallet e DESTA moeda
  CONSTRAINT fk_ledger_tx_wallet_currency
    FOREIGN KEY (transaction_id, wallet_id, currency)
    REFERENCES wager_transactions (id, wallet_id, currency),

  CONSTRAINT uq_ledger_one_entry_per_tx_wallet UNIQUE (wallet_id, transaction_id), -- "no máximo um por wallet"
  CONSTRAINT uq_ledger_wallet_version          UNIQUE (wallet_id, wallet_version),  -- história linear; cursor estável

  -- aritmética verificada pelo banco
  CONSTRAINT ck_ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
  )
);

-- -----------------------------------------------------------------------------
-- 4. INBOX e OUTBOX
-- -----------------------------------------------------------------------------
CREATE TABLE inbox_messages (
  consumer_name  TEXT        NOT NULL,
  message_id     TEXT        NOT NULL,
  payload_hash   CHAR(64)    NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               UUID        PRIMARY KEY,           -- = eventId (chave de dedupe do consumidor)
  aggregate_id     UUID        NOT NULL,
  event_type       TEXT        NOT NULL,
  event_version    INTEGER     NOT NULL CHECK (event_version >= 1),
  payload          JSONB       NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  attempts         INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by        TEXT,
  locked_until     TIMESTAMPTZ,
  published_at     TIMESTAMPTZ,
  last_error       TEXT,
  CONSTRAINT ck_outbox_lease CHECK ((locked_by IS NULL) = (locked_until IS NULL))
);

CREATE INDEX ix_outbox_due
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;

-- -----------------------------------------------------------------------------
-- 5. IMUTABILIDADE ESTRUTURAL (triggers)
-- -----------------------------------------------------------------------------

-- 5.1 Ledger: nenhum UPDATE, DELETE ou TRUNCATE. Nunca.
CREATE FUNCTION fn_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER trg_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();

CREATE TRIGGER trg_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_append_only();

-- 5.2 Transações: estado terminal é final; campos de negócio nunca mudam; sem DELETE.
CREATE FUNCTION fn_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'transaction % is terminal (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable columns of transaction % cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- transições válidas a partir de estados não-terminais
  IF NOT (
       (OLD.status = 'PENDING'           AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
    OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_tx_guard
  BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_tx_guard();

-- 5.3 Outbox: o payload de um evento nunca muda; publicado não "despublica".
CREATE FUNCTION fn_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.event_version, NEW.payload, NEW.occurred_at)
     IS DISTINCT FROM
     (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.event_version, OLD.payload, OLD.occurred_at) THEN
    RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'outbox event % already published', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_outbox_guard
  BEFORE UPDATE ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION fn_outbox_guard();

-- -----------------------------------------------------------------------------
-- 6. COERÊNCIA WALLET ⇔ LEDGER (constraint triggers DIFERIDOS, checados no COMMIT)
--
-- "Toda alteração de saldo tem um lançamento correspondente (e vice-versa)" e
-- "version incrementa somente quando o saldo muda" — garantidos pelo banco.
-- Diferidos porque, dentro da transação, a ordem UPDATE wallet / INSERT ledger
-- é livre; o que importa é o estado no COMMIT.
-- -----------------------------------------------------------------------------

-- 6.1 Cada mudança de wallet precisa de exatamente o lançamento que a explica.
CREATE FUNCTION fn_wallet_ledger_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e wallet_ledger_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'wallet % must be created with version 1', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.balance_amount = 0 THEN
      RETURN NULL;  -- abertura sem saldo: nenhum lançamento exigido
    END IF;
    SELECT * INTO e FROM wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = 1;
    IF NOT FOUND OR e.direction <> 'CREDIT' OR e.balance_before <> 0 OR e.amount <> NEW.balance_amount THEN
      RAISE EXCEPTION 'wallet % opened with balance % but no matching OPENING credit', NEW.id, NEW.balance_amount
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- UPDATE
  IF NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wallet % identity columns are immutable', NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.balance_amount = OLD.balance_amount THEN
    IF NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'wallet % version changed without balance change', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet % balance changed but version went % -> % (expected +1)', NEW.id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO e FROM wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
  IF NOT FOUND
     OR e.balance_before <> OLD.balance_amount
     OR e.balance_after  <> NEW.balance_amount THEN
    RAISE EXCEPTION 'wallet % changed % -> % (v%) without matching ledger entry',
      NEW.id, OLD.balance_amount, NEW.balance_amount, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ctrg_wallet_ledger_coherence
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_wallet_ledger_coherence();

-- 6.2 "Vice-versa": nenhum lançamento órfão. No COMMIT, a wallet precisa ter
-- alcançado a versão do lançamento e o encadeamento precisa fechar.
CREATE FUNCTION fn_ledger_entry_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w wallets%ROWTYPE;
  prev_after NUMERIC(20,2);
BEGIN
  SELECT * INTO w FROM wallets WHERE id = NEW.wallet_id;
  IF w.version < NEW.wallet_version THEN
    RAISE EXCEPTION 'ledger entry % (v%) has no matching wallet change (wallet at v%)',
      NEW.id, NEW.wallet_version, w.version USING ERRCODE = 'check_violation';
  END IF;

  SELECT balance_after INTO prev_after
    FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
   ORDER BY wallet_version DESC
   LIMIT 1;

  IF COALESCE(prev_after, 0) <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken at wallet % v%: previous after=% but before=%',
      NEW.wallet_id, NEW.wallet_version, COALESCE(prev_after, 0), NEW.balance_before
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ctrg_ledger_entry_coherence
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_entry_coherence();

COMMIT;

-- -----------------------------------------------------------------------------
-- 7. (Opcional, forte) papel da aplicação sem permissão destrutiva
-- -----------------------------------------------------------------------------
-- CREATE ROLE wagering_app LOGIN PASSWORD '...';
-- GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wagering_app;
-- GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;   -- sem UPDATE/DELETE
-- As migrations rodam com outro papel (owner). Defesa em profundidade além dos triggers.
