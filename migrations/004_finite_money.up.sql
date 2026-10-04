-- PostgreSQL numeric supports NaN and sorts it above finite values; >= 0 alone is insufficient.
ALTER TABLE wallets ADD CONSTRAINT wallet_finite_balance CHECK (balance <> 'NaN'::numeric);
ALTER TABLE wager_transactions ADD CONSTRAINT transaction_finite_amount CHECK (amount <> 'NaN'::numeric);
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_finite_money CHECK (
 amount <> 'NaN'::numeric AND balance_before <> 'NaN'::numeric AND balance_after <> 'NaN'::numeric
);
