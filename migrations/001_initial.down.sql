DROP TABLE outbox,inbox,wallet_ledger,wager_transactions,wallets CASCADE;
DROP FUNCTION check_transaction_ledger(),check_wallet_ledger(),protect_transaction(),deny_ledger_mutation();
