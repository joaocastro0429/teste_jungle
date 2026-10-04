DROP TRIGGER outbox_identity ON outbox;
DROP FUNCTION protect_outbox_identity();
DROP TRIGGER transaction_no_delete ON wager_transactions;
DROP FUNCTION deny_transaction_delete();
