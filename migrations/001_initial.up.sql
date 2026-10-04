CREATE TABLE wallets (
 id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 balance numeric(18,2) NOT NULL CHECK (balance >= 0), version integer NOT NULL CHECK (version >= 1),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (player_id, currency), UNIQUE (id, currency)
);
CREATE TABLE wager_transactions (
 id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
 idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL,
 wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL, round_id text NOT NULL, game_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 amount numeric(18,2) NOT NULL CHECK (amount >= 0), currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 reference_external_transaction_id text, reference_transaction_id uuid REFERENCES wager_transactions(id),
 status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 failure_code text, response jsonb, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 UNIQUE(provider_id, external_transaction_id), UNIQUE(id, wallet_id, currency),
 CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
 CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
 CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
 CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL)
);
CREATE UNIQUE INDEX single_reversal ON wager_transactions(reference_transaction_id,kind)
 WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX pending_references ON wager_transactions(next_attempt_at,id) WHERE status = 'PENDING_REFERENCE';
CREATE TABLE wallet_ledger (
 id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 wallet_id uuid NOT NULL, transaction_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
 amount numeric(18,2) NOT NULL CHECK(amount > 0), currency varchar(3) NOT NULL,
 balance_before numeric(18,2) NOT NULL CHECK(balance_before >= 0), balance_after numeric(18,2) NOT NULL CHECK(balance_after >= 0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(wallet_id,transaction_id),
 FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
 FOREIGN KEY(transaction_id,wallet_id,currency) REFERENCES wager_transactions(id,wallet_id,currency),
 CHECK ((direction='CREDIT' AND balance_after=balance_before+amount) OR (direction='DEBIT' AND balance_after=balance_before-amount))
);
CREATE INDEX ledger_cursor ON wallet_ledger(wallet_id,sequence);
CREATE TABLE inbox (
 consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, response jsonb,
 PRIMARY KEY(consumer_name,message_id)
);
CREATE TABLE outbox (
 id uuid PRIMARY KEY, aggregate_id uuid NOT NULL REFERENCES wallets(id), event_type text NOT NULL,
 payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX outbox_due ON outbox(next_attempt_at,occurred_at) WHERE published_at IS NULL;
CREATE FUNCTION deny_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger
 FOR EACH STATEMENT EXECUTE FUNCTION deny_ledger_mutation();
CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
   RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW.id,NEW.wallet_id,NEW.player_id,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,NEW.kind,NEW.amount,NEW.currency,NEW.round_id,NEW.game_id,NEW.reference_external_transaction_id)
 IS DISTINCT FROM (OLD.id,OLD.wallet_id,OLD.player_id,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,OLD.kind,OLD.amount,OLD.currency,OLD.round_id,OLD.game_id,OLD.reference_external_transaction_id) THEN
   RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transaction_immutable BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION protect_transaction();
-- Deferred constraints inspect final commit state, so balance and ledger can be written in either order.
CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; stored numeric; reconstructed numeric;
BEGIN
 IF TG_TABLE_NAME='wallets' THEN wid:=NEW.id; ELSE wid:=NEW.wallet_id; END IF;
 SELECT balance INTO stored FROM wallets WHERE id=wid;
 SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) INTO reconstructed FROM wallet_ledger WHERE wallet_id=wid;
 IF stored IS DISTINCT FROM reconstructed THEN RAISE EXCEPTION 'wallet/ledger mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_balanced AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; tx wager_transactions%ROWTYPE; entries integer; expected_direction text;
BEGIN
 IF TG_TABLE_NAME='wager_transactions' THEN tid:=NEW.id; ELSE tid:=NEW.transaction_id; END IF;
 SELECT * INTO tx FROM wager_transactions WHERE id=tid;
 SELECT count(*) INTO entries FROM wallet_ledger WHERE transaction_id=tid;
 IF tx.status='PROCESSED' AND tx.kind<>'LOSS' THEN
   IF entries<>1 THEN RAISE EXCEPTION 'processed financial transaction requires ledger' USING ERRCODE='23514'; END IF;
   expected_direction:=CASE WHEN tx.kind='BET' THEN 'DEBIT' WHEN tx.kind='ROLLBACK' AND (SELECT kind FROM wager_transactions WHERE id=tx.reference_transaction_id)<>'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
   IF NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE transaction_id=tid AND amount=tx.amount AND direction=expected_direction) THEN
     RAISE EXCEPTION 'ledger does not match transaction' USING ERRCODE='23514';
   END IF;
 ELSIF entries<>0 THEN RAISE EXCEPTION 'non-financial transaction cannot have ledger' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_has_ledger AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
CREATE CONSTRAINT TRIGGER ledger_has_transaction AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
