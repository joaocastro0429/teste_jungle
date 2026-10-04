CREATE FUNCTION deny_transaction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'transactions are audit records and cannot be deleted' USING ERRCODE='23514'; END $$;
CREATE TRIGGER transaction_no_delete BEFORE DELETE OR TRUNCATE ON wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION deny_transaction_delete();
CREATE FUNCTION protect_outbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.occurred_at) IS DISTINCT FROM (OLD.id,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.occurred_at) THEN
 RAISE EXCEPTION 'outbox event identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_identity BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION protect_outbox_identity();
