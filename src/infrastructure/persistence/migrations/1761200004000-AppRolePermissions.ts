import { MigrationInterface, QueryRunner } from 'typeorm';

export class AppRolePermissions1761200004000 implements MigrationInterface {
  name = 'AppRolePermissions1761200004000';

  async up(q: QueryRunner): Promise<void> {
    const appRole = process.env.APP_DB_USER ?? 'jungle_app';
    const safeRole = appRole.replaceAll('"', '""');
    await q.query(`GRANT SELECT,INSERT,UPDATE ON wallets,wager_transactions,inbox_messages,outbox_messages TO "${safeRole}"`);
    await q.query(`GRANT SELECT,INSERT ON wallet_ledger,reconciliation_audits TO "${safeRole}"`);
    await q.query(`GRANT USAGE,SELECT ON SEQUENCE reconciliation_audits_id_seq TO "${safeRole}"`);
    await q.query(`CREATE TRIGGER wallet_ledger_immutable_truncate BEFORE TRUNCATE ON wallet_ledger
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation()`);
  }

  async down(q: QueryRunner): Promise<void> {
    const appRole = process.env.APP_DB_USER ?? 'jungle_app';
    const safeRole = appRole.replaceAll('"', '""');
    await q.query(`DROP TRIGGER IF EXISTS wallet_ledger_immutable_truncate ON wallet_ledger`);
    await q.query(`REVOKE SELECT,INSERT,UPDATE ON wallets,wager_transactions,inbox_messages,outbox_messages FROM "${safeRole}"`);
    await q.query(`REVOKE SELECT,INSERT ON wallet_ledger,reconciliation_audits FROM "${safeRole}"`);
    await q.query(`REVOKE USAGE,SELECT ON SEQUENCE reconciliation_audits_id_seq FROM "${safeRole}"`);
  }
}
