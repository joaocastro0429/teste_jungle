ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_finite_money;
ALTER TABLE wager_transactions DROP CONSTRAINT transaction_finite_amount;
ALTER TABLE wallets DROP CONSTRAINT wallet_finite_balance;
