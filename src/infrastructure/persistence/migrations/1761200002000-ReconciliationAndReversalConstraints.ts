import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReconciliationAndReversalConstraints1761200002000 implements MigrationInterface {
  name = 'ReconciliationAndReversalConstraints1761200002000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_id_wallet_currency_unique UNIQUE(id,wallet_id,currency)`);
    await q.query(`ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_transaction_wallet_fk`);
    await q.query(`ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_transaction_wallet_currency_fk
      FOREIGN KEY(transaction_id,wallet_id,currency) REFERENCES wager_transactions(id,wallet_id,currency)`);
    await q.query(`CREATE UNIQUE INDEX wager_reversal_once_idx ON wager_transactions(provider_id,reference_external_transaction_id,kind)
      WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    await q.query(`CREATE TABLE reconciliation_audits (
      id bigserial PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES wallets(id), stored_balance numeric(20,2) NOT NULL,
      calculated_balance numeric(20,2) NOT NULL, is_consistent boolean NOT NULL, checked_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX reconciliation_audits_mismatch_idx ON reconciliation_audits(checked_at DESC) WHERE is_consistent=false`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS reconciliation_audits`);
    await q.query(`DROP INDEX IF EXISTS wager_reversal_once_idx`);
    await q.query(`ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_transaction_wallet_currency_fk`);
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_id_wallet_currency_unique`);
    await q.query(`ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_transaction_wallet_fk
      FOREIGN KEY(transaction_id,wallet_id) REFERENCES wager_transactions(id,wallet_id)`);
  }
}
