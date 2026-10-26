import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialIntegrity1761200001000 implements MigrationInterface {
  name = 'FinancialIntegrity1761200001000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE inbox_messages ADD COLUMN payload_hash char(64) NOT NULL DEFAULT repeat('0',64)`);
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_transaction_reference_required
      CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`);
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT opening_transaction_is_internal
      CHECK (kind <> 'OPENING' OR provider_id='internal')`);
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_id_wallet_unique UNIQUE(id,wallet_id)`);
    await q.query(`ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_transaction_id_fkey`);
    await q.query(`ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_transaction_wallet_fk
      FOREIGN KEY(transaction_id,wallet_id) REFERENCES wager_transactions(id,wallet_id)`);
    await q.query(`CREATE FUNCTION prevent_terminal_transaction_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'terminal wager transaction status is immutable';
        END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER wager_transaction_terminal_immutable BEFORE UPDATE OF status ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_terminal_transaction_transition()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS wager_transaction_terminal_immutable ON wager_transactions`);
    await q.query(`DROP FUNCTION IF EXISTS prevent_terminal_transaction_transition()`);
    await q.query(`ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_transaction_wallet_fk`);
    await q.query(`ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_transaction_id_fkey FOREIGN KEY(transaction_id) REFERENCES wager_transactions(id)`);
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_id_wallet_unique`);
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS opening_transaction_is_internal`);
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transaction_reference_required`);
    await q.query(`ALTER TABLE inbox_messages DROP COLUMN IF EXISTS payload_hash`);
  }
}
