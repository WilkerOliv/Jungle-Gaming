import { MigrationInterface, QueryRunner } from 'typeorm';

export class FailedTransactionStatus1761200003000 implements MigrationInterface {
  name = 'FailedTransactionStatus1761200003000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_status_check`);
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_status_check
      CHECK (status IN ('PROCESSING','PROCESSED','REJECTED','FAILED','PENDING_REFERENCE'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_status_check`);
    await q.query(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_status_check
      CHECK (status IN ('PROCESSING','PROCESSED','REJECTED','PENDING_REFERENCE'))`);
  }
}
