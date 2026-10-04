CREATE FUNCTION protect_wallet_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'wallet must open with version 1' USING ERRCODE='23514'; END IF;
 ELSE
   IF (NEW.id,NEW.player_id,NEW.currency,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.player_id,OLD.currency,OLD.created_at) THEN
     RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE='23514'; END IF;
   IF NEW.version <> OLD.version + (CASE WHEN NEW.balance IS DISTINCT FROM OLD.balance THEN 1 ELSE 0 END) THEN
     RAISE EXCEPTION 'wallet version must track balance changes' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_state BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet_state();
