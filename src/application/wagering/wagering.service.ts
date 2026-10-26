import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events/integration-event';

type Submission = {
  providerId: string; externalTransactionId: string; idempotencyKey: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: 'BET'|'WIN'|'LOSS'|'REFUND'|'ROLLBACK';
  money: { amount: string; currency: string }; referenceExternalTransactionId?: string;
};

function canonicalHash(input: Submission): string {
  const keys: (keyof Submission)[] = ['providerId','externalTransactionId','playerId','walletId','roundId','gameId','kind','money','referenceExternalTransactionId'];
  const canonical = Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => {
    const value = input[key];
    return [key, key === 'money' ? { amount: input.money.amount, currency: input.money.currency.toUpperCase() } : value];
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);
  constructor(private readonly db: DataSource) {}

  async createWallet(playerId: string, initialBalance: { amount: string; currency: string }) {
    const money = Money.from(initialBalance);
    if (money.isNegative()) throw new DomainError('INVALID_INITIAL_BALANCE', 'Initial balance cannot be negative.');
    return this.db.transaction(async (manager) => {
      const id = randomUUID();
      const rows = await manager.query(`INSERT INTO wallets(id,player_id,balance,currency) VALUES($1,$2,$3,$4) RETURNING id,player_id,balance::text,currency,version`, [id,playerId,money.toString(),money.currency]);
      if (money.isPositive()) {
        const txId = randomUUID();
        await manager.query(`INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,player_id,wallet_id,round_id,game_id,kind,amount,currency,status,observed_balance,processed_at)
          VALUES($1,'internal',$2,$2,$3,$4,$5,'opening','internal','OPENING',$6,$7,'PROCESSED',$6,now())`, [txId,`opening:${id}`,'0'.repeat(64),playerId,id,money.toString(),money.currency]);
        await manager.query(`INSERT INTO wallet_ledger(wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,'CREDIT',$3,$4,0,$3)`, [id,txId,money.toString(),money.currency]);
      }
      return { id: rows[0].id, playerId: rows[0].player_id, balance: { amount: rows[0].balance, currency: rows[0].currency.trim() }, version: rows[0].version };
    });
  }

  async getWallet(walletId: string) {
    const rows = await this.db.query(`SELECT id,player_id,balance::text,currency,version FROM wallets WHERE id=$1`, [walletId]);
    if (!rows.length) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    const w = rows[0]; return { id: w.id, playerId: w.player_id, balance: { amount: w.balance, currency: w.currency.trim() }, version: w.version };
  }

  async submit(input: Submission, inbox?: { consumerName: string; messageId: string }) {
    if (!['BET','WIN','LOSS','REFUND','ROLLBACK'].includes(input.kind)) throw new DomainError('INVALID_KIND', 'OPENING is an internal transaction kind.');
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Amount must be positive.');
    if (['REFUND','ROLLBACK'].includes(input.kind) && !input.referenceExternalTransactionId) throw new DomainError('REFERENCE_REQUIRED','Reference is required.');
    const hash = canonicalHash(input);
    const result = await this.db.transaction(async (manager) => {
      if (inbox) {
        const inserted = await manager.query(`INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,status) VALUES($1,$2,$3,'PROCESSING') ON CONFLICT DO NOTHING RETURNING message_id`, [inbox.consumerName,inbox.messageId,hash]);
        if (!inserted.length) {
          const existingForMessage = await manager.query(`SELECT i.payload_hash,t.* FROM inbox_messages i JOIN wager_transactions t ON t.provider_id=$3 AND t.idempotency_key=$4 WHERE i.consumer_name=$1 AND i.message_id=$2`, [inbox.consumerName,inbox.messageId,input.providerId,input.idempotencyKey]);
          if (existingForMessage.length) {
            if (existingForMessage[0].payload_hash.trim() !== hash) throw new ConflictException({ code: 'INBOX_MESSAGE_REUSED' });
            await manager.query(`UPDATE wager_transactions SET replay_count=replay_count+1 WHERE id=$1`, [existingForMessage[0].id]);
            return this.response(existingForMessage[0], true);
          }
          throw new ConflictException({ code: 'INBOX_MESSAGE_REUSED' });
        }
      }
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${input.providerId}:${input.idempotencyKey}`]);
      const existing = await manager.query(`SELECT * FROM wager_transactions WHERE provider_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.providerId,input.idempotencyKey]);
      if (existing.length) {
        if (existing[0].payload_hash.trim() !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        if (inbox) await manager.query(`UPDATE inbox_messages SET status='PROCESSED',processed_at=now() WHERE consumer_name=$1 AND message_id=$2`, [inbox.consumerName,inbox.messageId]);
        await manager.query(`UPDATE wager_transactions SET replay_count=replay_count+1 WHERE id=$1`, [existing[0].id]);
        return this.response(existing[0], true);
      }
      const walletRows = await manager.query(`SELECT * FROM wallets WHERE id=$1 FOR UPDATE`, [input.walletId]);
      if (!walletRows.length) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      const wallet = walletRows[0];
      if (wallet.player_id !== input.playerId || wallet.currency.trim() !== money.currency) throw new UnprocessableEntityException({ code: 'WALLET_IDENTITY_MISMATCH' });
      const txId = randomUUID();
      await manager.query(`INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,player_id,wallet_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PROCESSING')`, [txId,input.providerId,input.externalTransactionId,input.idempotencyKey,hash,input.playerId,input.walletId,input.roundId,input.gameId,input.kind,money.toString(),money.currency,input.referenceExternalTransactionId ?? null]);

      let direction: 'DEBIT'|'CREDIT'|undefined;
      let amount = money;
      let failure: string | undefined;
      if (input.kind === 'BET') direction = 'DEBIT';
      if (input.kind === 'WIN' || input.kind === 'REFUND') direction = 'CREDIT';
      if (input.kind === 'ROLLBACK') {
        const reference = await manager.query(`SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2 FOR UPDATE`, [input.providerId,input.referenceExternalTransactionId]);
        if (!reference.length) failure = 'REFERENCE_NOT_FOUND';
        else if (!['BET','WIN','REFUND'].includes(reference[0].kind)) failure = 'INVALID_REFERENCE_KIND';
        else if (reference[0].status === 'PENDING_REFERENCE') failure = 'REFERENCE_PENDING';
        else if (reference[0].status !== 'PROCESSED') failure = 'REFERENCE_NOT_PROCESSED';
        else if (reference[0].player_id !== input.playerId || reference[0].wallet_id !== input.walletId || reference[0].round_id !== input.roundId || reference[0].currency.trim() !== money.currency || reference[0].amount !== money.toString()) failure = 'REFERENCE_MISMATCH';
        else {
          const prior = await manager.query(`SELECT id FROM wager_transactions WHERE provider_id=$1 AND reference_external_transaction_id=$2 AND kind='ROLLBACK' AND status='PROCESSED'`, [input.providerId,input.referenceExternalTransactionId]);
          if (prior.length) failure = 'REFERENCE_ALREADY_REVERSED';
          else direction = reference[0].kind === 'BET' ? 'CREDIT' : 'DEBIT';
        }
      }
      if (input.kind === 'REFUND') {
        const reference = await manager.query(`SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2 FOR UPDATE`, [input.providerId,input.referenceExternalTransactionId]);
        if (!reference.length) failure = 'REFERENCE_NOT_FOUND';
        else if (reference[0].kind !== 'BET' || reference[0].status !== 'PROCESSED') failure = 'INVALID_REFUND_REFERENCE';
        else if (reference[0].player_id !== input.playerId || reference[0].wallet_id !== input.walletId || reference[0].round_id !== input.roundId || reference[0].currency.trim() !== money.currency || reference[0].amount !== money.toString()) failure = 'REFERENCE_MISMATCH';
        else {
          const prior = await manager.query(`SELECT id FROM wager_transactions WHERE provider_id=$1 AND reference_external_transaction_id=$2 AND kind='REFUND' AND status='PROCESSED'`, [input.providerId,input.referenceExternalTransactionId]);
          if (prior.length) failure = 'REFERENCE_ALREADY_REVERSED';
        }
      }
      let before = Money.rehydrate({ amount: wallet.balance, currency: wallet.currency.trim() });
      let after = before;
      if (!failure && direction) {
        try { after = direction === 'DEBIT' ? before.subtract(amount) : before.add(amount); }
        catch (e) { if (e instanceof DomainError) throw e; throw e; }
        if (after.isNegative()) failure = input.kind === 'ROLLBACK' ? 'ROLLBACK_WOULD_OVERDRAW' : 'INSUFFICIENT_FUNDS';
      }
      const status = ['REFERENCE_NOT_FOUND','REFERENCE_PENDING'].includes(failure ?? '') ? 'PENDING_REFERENCE' : failure ? 'REJECTED' : 'PROCESSED';
      if (!failure) {
        if (direction) {
          await manager.query(`UPDATE wallets SET balance=$2,version=version+1 WHERE id=$1`, [input.walletId,after.toString()]);
          await manager.query(`INSERT INTO wallet_ledger(wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.walletId,txId,direction,amount.toString(),money.currency,before.toString(),after.toString()]);
        }
      }
      await manager.query(`UPDATE wager_transactions SET status=$2,failure_code=$3,observed_balance=$4,processed_at=CASE WHEN $2='PENDING_REFERENCE' THEN NULL ELSE now() END WHERE id=$1`, [txId,status,failure ?? null,after.toString()]);
      const eventData = { transactionId: txId, walletId: input.walletId, providerId: input.providerId, status, failureCode: failure ?? null };
      const event = status === 'PENDING_REFERENCE' ? new WagerTransactionPendingReference(txId,eventData,{correlationId:txId}) : status === 'REJECTED' ? new WagerTransactionRejected(txId,eventData,{correlationId:txId}) : new WagerTransactionProcessed(txId,eventData,{correlationId:txId});
      await manager.query(`INSERT INTO outbox_messages(event_id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)`, [event.eventId,txId,event.eventType,JSON.stringify(event.toJSON())]);
      if (!failure && direction) {
        const changed = new WalletBalanceChanged(input.walletId,{walletId:input.walletId,transactionId:txId,direction,money:money.toJSON(),balanceBefore:before.toJSON(),balanceAfter:after.toJSON(),walletVersion:Number(wallet.version)+1},{correlationId:txId,causationId:event.eventId});
        await manager.query(`INSERT INTO outbox_messages(event_id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)`, [changed.eventId,input.walletId,changed.eventType,JSON.stringify(changed.toJSON())]);
      }
      if (inbox) await manager.query(`UPDATE inbox_messages SET status='PROCESSED',processed_at=now() WHERE consumer_name=$1 AND message_id=$2`, [inbox.consumerName,inbox.messageId]);
      return { transactionId: txId, status, balance: after.toJSON(), idempotentReplay: false, ...(failure ? { failureCode: failure } : {}) };
    });
    this.logger.log(JSON.stringify({ event: 'wager_transaction_committed', correlationId: result.transactionId, ...(inbox ? { messageId: inbox.messageId } : {}), transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId, status: result.status, idempotentReplay: result.idempotentReplay }));
    return result;
  }

  async getTransaction(id: string) {
    const rows = await this.db.query(`SELECT * FROM wager_transactions WHERE id=$1`, [id]);
    if (!rows.length) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.response(rows[0], false);
  }
  async getExternal(providerId: string, externalId: string) {
    const rows = await this.db.query(`SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2`, [providerId,externalId]);
    if (!rows.length) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.response(rows[0], false);
  }
  async ledger(walletId: string, limit: number, cursor?: string) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit,100) : 50;
    const cursorDecoded = cursor ? Buffer.from(cursor, 'base64url').toString('utf8').split('|') : undefined;
    if (cursorDecoded && (cursorDecoded.length !== 2 || Number.isNaN(Date.parse(cursorDecoded[0])) || !/^[0-9a-f-]{36}$/i.test(cursorDecoded[1]))) {
      throw new DomainError('INVALID_CURSOR', 'Ledger cursor is invalid.');
    }
    const cursorValue = cursorDecoded;
    const rows = await this.db.query(`SELECT id,transaction_id,direction,amount::text,currency,balance_before::text,balance_after::text,created_at::text AS created_at FROM wallet_ledger
      WHERE wallet_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, [walletId,cursorValue?.[0] ?? null,cursorValue?.[1] ?? null,safeLimit+1]);
    const hasMore = rows.length > safeLimit; const page = rows.slice(0,safeLimit); const last = page[page.length-1];
    return { items: page, nextCursor: hasMore && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null };
  }
  async reconcile(walletId: string) {
    const rows = await this.db.query(`SELECT w.balance::text AS stored,w.currency,COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated,COUNT(l.id)::int AS entries FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`, [walletId]);
    if (!rows.length) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    const r=rows[0], stored=Money.rehydrate({amount:r.stored,currency:r.currency.trim()}), calculated=Money.rehydrate({amount:r.calculated,currency:r.currency.trim()});
    const consistent = stored.equals(calculated);
    await this.db.query(`INSERT INTO reconciliation_audits(wallet_id,stored_balance,calculated_balance,is_consistent) VALUES($1,$2,$3,$4)`, [walletId,stored.toString(),calculated.toString(),consistent]);
    if (!consistent) this.logger.error(JSON.stringify({ event: 'wallet_reconciliation_mismatch', correlationId: randomUUID(), walletId, checkedEntries: r.entries }));
    return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(), difference: stored.subtract(calculated).toJSON(), consistent, checkedEntries: r.entries };
  }

  async retryPendingReferences(batchSize = 50): Promise<number> {
    return this.db.transaction(async (manager) => {
      const pending = await manager.query(`SELECT id,wallet_id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at LIMIT $1`, [batchSize]);
      let completed = 0;
      for (const candidate of pending) {
        // Always acquire wallet before transaction/reference locks, matching submit() and preventing lock-order deadlocks.
        const wallets = await manager.query(`SELECT * FROM wallets WHERE id=$1 FOR UPDATE`, [candidate.wallet_id]);
        const lockedTransactions = await manager.query(`SELECT * FROM wager_transactions WHERE id=$1 AND status='PENDING_REFERENCE' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) FOR UPDATE SKIP LOCKED`, [candidate.id]);
        if (!wallets.length || !lockedTransactions.length) continue;
        const tx = lockedTransactions[0];
        const attempts = Number(tx.attempts) + 1;
        const refs = await manager.query(`SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2 FOR UPDATE`, [tx.provider_id,tx.reference_external_transaction_id]);
        let failure: string | undefined;
        let direction: 'DEBIT'|'CREDIT'|undefined;
        if (!refs.length) {
          if (attempts >= 12) failure = 'REFERENCE_NOT_FOUND_EXPIRED';
          else {
            await manager.query(`UPDATE wager_transactions SET attempts=$2,next_attempt_at=now()+LEAST(interval '1 hour',interval '2 seconds'*power(2,LEAST($2,10))) WHERE id=$1`, [tx.id,attempts]);
            continue;
          }
        } else {
          const ref = refs[0];
          if (ref.status === 'PENDING_REFERENCE' || ref.status === 'PROCESSING') {
            if (attempts >= 12) failure = 'REFERENCE_NOT_PROCESSED_EXPIRED';
            else {
              await manager.query(`UPDATE wager_transactions SET attempts=$2,next_attempt_at=now()+LEAST(interval '1 hour',interval '2 seconds'*power(2,LEAST($2,10))) WHERE id=$1`, [tx.id,attempts]);
              continue;
            }
          } else if (ref.status !== 'PROCESSED') failure = 'REFERENCE_NOT_PROCESSED';
          else if (ref.player_id !== tx.player_id || ref.wallet_id !== tx.wallet_id || ref.round_id !== tx.round_id || ref.currency.trim() !== tx.currency.trim() || ref.amount !== tx.amount) failure = 'REFERENCE_MISMATCH';
          else if (tx.kind === 'REFUND' && ref.kind !== 'BET') failure = 'INVALID_REFUND_REFERENCE';
          else if (tx.kind === 'ROLLBACK' && !['BET','WIN','REFUND'].includes(ref.kind)) failure = 'INVALID_REFERENCE_KIND';
          else {
            const prior = await manager.query(`SELECT id FROM wager_transactions WHERE provider_id=$1 AND reference_external_transaction_id=$2 AND kind=$3 AND status='PROCESSED' FOR UPDATE`, [tx.provider_id,tx.reference_external_transaction_id,tx.kind]);
            if (prior.length) failure = 'REFERENCE_ALREADY_REVERSED';
            else direction = tx.kind === 'REFUND' ? 'CREDIT' : ref.kind === 'BET' ? 'CREDIT' : 'DEBIT';
          }
        }
        let before = Money.rehydrate({ amount: wallets[0].balance, currency: wallets[0].currency.trim() });
        let after = before;
        const amount = Money.rehydrate({ amount: tx.amount, currency: tx.currency.trim() });
        if (!failure && direction && before) {
          after = direction === 'DEBIT' ? before.subtract(amount) : before.add(amount);
          if (after.isNegative()) failure = tx.kind === 'ROLLBACK' ? 'ROLLBACK_WOULD_OVERDRAW' : 'INSUFFICIENT_FUNDS';
        }
        const status = failure ? 'REJECTED' : 'PROCESSED';
        if (!failure && direction && before && after) {
          await manager.query(`UPDATE wallets SET balance=$2,version=version+1 WHERE id=$1`, [tx.wallet_id,after.toString()]);
          await manager.query(`INSERT INTO wallet_ledger(wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7)`, [tx.wallet_id,tx.id,direction,amount.toString(),tx.currency.trim(),before.toString(),after.toString()]);
        }
        const observed = after ?? before;
        await manager.query(`UPDATE wager_transactions SET status=$2,failure_code=$3,observed_balance=$4,attempts=$5,next_attempt_at=NULL,processed_at=now() WHERE id=$1`, [tx.id,status,failure ?? null,observed.toString(),attempts]);
        const eventData = {transactionId:tx.id,walletId:tx.wallet_id,providerId:tx.provider_id,status,failureCode:failure ?? null};
        const event = status==='PROCESSED' ? new WagerTransactionProcessed(tx.id,eventData,{correlationId:tx.id}) : new WagerTransactionRejected(tx.id,eventData,{correlationId:tx.id});
        await manager.query(`INSERT INTO outbox_messages(event_id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)`, [event.eventId,tx.id,event.eventType,JSON.stringify(event.toJSON())]);
        if (!failure && direction && before && after) {
          const changed = new WalletBalanceChanged(tx.wallet_id,{walletId:tx.wallet_id,transactionId:tx.id,direction,money:amount.toJSON(),balanceBefore:before.toJSON(),balanceAfter:after.toJSON(),walletVersion:Number(wallets[0].version)+1},{correlationId:tx.id,causationId:event.eventId});
          await manager.query(`INSERT INTO outbox_messages(event_id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)`, [changed.eventId,tx.wallet_id,changed.eventType,JSON.stringify(changed.toJSON())]);
        }
        completed++;
      }
      return completed;
    });
  }
  private response(row: any, replay: boolean) {
    return { transactionId: row.id, status: row.status, balance: row.observed_balance === null ? null : { amount: String(row.observed_balance).includes('.') ? String(row.observed_balance) : `${row.observed_balance}.00`, currency: row.currency.trim() }, idempotentReplay: replay, ...(row.failure_code ? { failureCode: row.failure_code } : {}) };
  }
}
