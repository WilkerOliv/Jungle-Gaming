import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DataSource } from 'typeorm';
import { WageringService } from '../src/application/wagering/wagering.service';
import { InitialSchema1761200000000 } from '../src/infrastructure/persistence/migrations/1761200000000-InitialSchema';
import { FinancialIntegrity1761200001000 } from '../src/infrastructure/persistence/migrations/1761200001000-FinancialIntegrity';
import { ReconciliationAndReversalConstraints1761200002000 } from '../src/infrastructure/persistence/migrations/1761200002000-ReconciliationAndReversalConstraints';
import { FailedTransactionStatus1761200003000 } from '../src/infrastructure/persistence/migrations/1761200003000-FailedTransactionStatus';
import { AppRolePermissions1761200004000 } from '../src/infrastructure/persistence/migrations/1761200004000-AppRolePermissions';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('wagering PostgreSQL concurrency invariants', () => {
  let database: DataSource;
  let migrationDatabase: DataSource;
  let service: WageringService;

  beforeAll(async () => {
    migrationDatabase = new DataSource({ type: 'postgres', url: process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL, migrations: [InitialSchema1761200000000, FinancialIntegrity1761200001000, ReconciliationAndReversalConstraints1761200002000, FailedTransactionStatus1761200003000, AppRolePermissions1761200004000], synchronize: false });
    await migrationDatabase.initialize();
    await migrationDatabase.runMigrations();
    database = new DataSource({ type: 'postgres', url: process.env.TEST_DATABASE_URL, synchronize: false });
    await database.initialize();
    service = new WageringService(database);
  });
  afterAll(async () => { if (database?.isInitialized) await database.destroy(); if (migrationDatabase?.isInitialized) await migrationDatabase.destroy(); });

  function bet(walletId: string, playerId: string, externalTransactionId: string, idempotencyKey: string, amount: string) {
    return { providerId: 'integration-test', externalTransactionId, idempotencyKey, playerId, walletId, roundId: randomUUID(), gameId: 'integration-test', kind: 'BET' as const, money: { amount, currency: 'BRL' } };
  }

  it('applies one debit for fifty simultaneous deliveries of the same idempotency key', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const request = bet(wallet.id, playerId, `same-${randomUUID()}`, `key-${randomUUID()}`, '80.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => service.submit(request)));
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    const ledger = await database.query(`SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'`, [wallet.id]);
    expect(ledger[0].count).toBe(1);
    expect((await service.reconcile(wallet.id)).storedBalance.amount).toBe('20.00');
  });

  it('deduplicates the Inbox atomically and rejects message ID reuse with different business data', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const request = bet(wallet.id, playerId, `inbox-${randomUUID()}`, `inbox-key-${randomUUID()}`, '30.00');
    const inbox = { consumerName: 'integration-consumer', messageId: `message-${randomUUID()}` };
    const first = await service.submit(request, inbox);
    const replay = await service.submit(request, inbox);
    expect(first.status).toBe('PROCESSED');
    expect(replay.idempotentReplay).toBe(true);
    await expect(service.submit({ ...request, money: { amount: '31.00', currency: 'BRL' } }, inbox)).rejects.toMatchObject({ status: 409 });
    const rows = await database.query(`SELECT status,payload_hash FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2`, [inbox.consumerName,inbox.messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PROCESSED');
    expect(rows[0].payload_hash.trim()).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.reconcile(wallet.id)).storedBalance.amount).toBe('70.00');
  });

  it('rolls back wallet, transaction, ledger, inbox, and outbox together on a PostgreSQL failure', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const externalTransactionId = `atomic-${randomUUID()}`;
    const request = bet(wallet.id, playerId, externalTransactionId, `atomic-key-${randomUUID()}`, '20.00');
    const inbox = { consumerName: 'atomic-test', messageId: `atomic-message-${randomUUID()}` };
    const outboxBefore = Number((await database.query(`SELECT count(*)::int AS count FROM outbox_messages`))[0].count);
    await migrationDatabase.query(`CREATE FUNCTION fail_outbox_for_integration_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$`);
    await migrationDatabase.query(`CREATE TRIGGER fail_outbox_for_integration_test BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION fail_outbox_for_integration_test()`);
    try {
      await expect(service.submit(request, inbox)).rejects.toThrow('forced outbox failure');
    } finally {
      await migrationDatabase.query(`DROP TRIGGER IF EXISTS fail_outbox_for_integration_test ON outbox_messages`);
      await migrationDatabase.query(`DROP FUNCTION IF EXISTS fail_outbox_for_integration_test()`);
    }
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect((await database.query(`SELECT count(*)::int AS count FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2`, [request.providerId,externalTransactionId]))[0].count).toBe(0);
    expect((await database.query(`SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1`, [wallet.id]))[0].count).toBe(1);
    expect((await database.query(`SELECT count(*)::int AS count FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2`, [inbox.consumerName,inbox.messageId]))[0].count).toBe(0);
    expect(Number((await database.query(`SELECT count(*)::int AS count FROM outbox_messages`))[0].count)).toBe(outboxBefore);
    expect((await service.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('enforces ledger immutability in PostgreSQL', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '1.00', currency: 'BRL' });
    const role = await database.query(`SELECT rolsuper FROM pg_roles WHERE rolname=current_user`);
    expect(role[0].rolsuper).toBe(false);
    await expect(database.query(`UPDATE wallet_ledger SET amount=2.00 WHERE wallet_id=$1`, [wallet.id])).rejects.toThrow('permission denied');
    await expect(database.query(`TRUNCATE wallet_ledger`)).rejects.toThrow('permission denied');
    await expect(migrationDatabase.query(`UPDATE wallet_ledger SET amount=2.00 WHERE wallet_id=$1`, [wallet.id])).rejects.toThrow('wallet ledger is immutable');
    await expect(migrationDatabase.query(`TRUNCATE wallet_ledger`)).rejects.toThrow('wallet ledger is immutable');
    expect((await service.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('allows only one of two concurrent bets that compete for the same balance', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const results = await Promise.all([
      service.submit(bet(wallet.id, playerId, `bet-a-${randomUUID()}`, `key-a-${randomUUID()}`, '80.00')),
      service.submit(bet(wallet.id, playerId, `bet-b-${randomUUID()}`, `key-b-${randomUUID()}`, '80.00')),
    ]);
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    const ledger = await database.query(`SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'`, [wallet.id]);
    expect(ledger[0].count).toBe(1);
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.consistent).toBe(true);
  });

  it('reprocesses a refund that arrived before its bet reference', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '25.00', currency: 'BRL' });
    const referenceId = `late-bet-${randomUUID()}`;
    const refund = await service.submit({
      providerId: 'out-of-order', externalTransactionId: `refund-${randomUUID()}`, idempotencyKey: `refund-key-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'late-round', gameId: 'late-game', kind: 'REFUND',
      money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: referenceId,
    });
    expect(refund.status).toBe('PENDING_REFERENCE');
    const betResult = await service.submit({
      providerId: 'out-of-order', externalTransactionId: referenceId, idempotencyKey: `bet-key-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'late-round', gameId: 'late-game', kind: 'BET', money: { amount: '20.00', currency: 'BRL' },
    });
    expect(betResult.status).toBe('PROCESSED');
    expect(await service.retryPendingReferences()).toBe(1);
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('25.00');
    expect(reconciliation.consistent).toBe(true);
  });

  it('rolls a processed win back once with the inverse ledger direction', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const winId = `win-${randomUUID()}`;
    await service.submit({
      providerId: 'rollback-test', externalTransactionId: winId, idempotencyKey: `win-key-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'rollback-round', gameId: 'rollback-game', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' },
    });
    const rollback = await service.submit({
      providerId: 'rollback-test', externalTransactionId: `rollback-${randomUUID()}`, idempotencyKey: `rollback-key-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'rollback-round', gameId: 'rollback-game', kind: 'ROLLBACK',
      money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: winId,
    });
    expect(rollback.status).toBe('PROCESSED');
    const duplicateRollback = await service.submit({
      providerId: 'rollback-test', externalTransactionId: `rollback-again-${randomUUID()}`, idempotencyKey: `rollback-key-again-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'rollback-round', gameId: 'rollback-game', kind: 'ROLLBACK',
      money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: winId,
    });
    expect(duplicateRollback.status).toBe('REJECTED');
    expect(duplicateRollback.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('100.00');
    expect(reconciliation.consistent).toBe(true);
  });

  it('serializes competing wallet updates across three real Node.js processes', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const requests = [0,1,2].map((index) => bet(wallet.id, playerId, `multi-${index}-${randomUUID()}`, `multi-key-${index}-${randomUUID()}`, '80.00'));
    const results = await Promise.all(requests.map((request) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['-r', 'ts-node/register', 'test/concurrency-worker.ts'], {
        cwd: process.cwd(), env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
        stdio: ['pipe','pipe','pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        const resultLine = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('{"transactionId"'));
        if (code !== 0 || !resultLine) return reject(new Error(`Wager worker process failed (${code}): ${stderr}\n${stdout}`));
        try { resolve(JSON.parse(resultLine)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(request));
    })));
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(2);
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.consistent).toBe(true);
  });

  it('processes independent wallets in parallel without cross-wallet contention', async () => {
    const players = [randomUUID(), randomUUID()];
    const wallets = await Promise.all(players.map((playerId) => service.createWallet(playerId, { amount: '100.00', currency: 'BRL' })));
    const requests = wallets.flatMap((wallet, index) => Array.from({ length: 5 }, (_, n) =>
      service.submit(bet(wallet.id, players[index], `parallel-${index}-${n}-${randomUUID()}`, `parallel-key-${index}-${n}-${randomUUID()}`, '10.00'))));
    const results = await Promise.all(requests);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      const reconciliation = await service.reconcile(wallet.id);
      expect(reconciliation.storedBalance.amount).toBe('50.00');
      expect(reconciliation.consistent).toBe(true);
    }
  });

  it('paginates the ledger with a stable opaque cursor', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    await service.submit({ ...bet(wallet.id, playerId, `cursor-bet-${randomUUID()}`, `cursor-key-${randomUUID()}`, '10.00') });
    await service.submit({
      providerId: 'integration-test', externalTransactionId: `cursor-win-${randomUUID()}`, idempotencyKey: `cursor-win-key-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'integration-test', kind: 'WIN', money: { amount: '1.00', currency: 'BRL' },
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.ledger(wallet.id, 1, cursor);
      ids.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
