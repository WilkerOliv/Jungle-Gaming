import { Money } from '../src/domain/money/money';
import { WagerTransaction } from '../src/domain/wagering/wager-transaction';
import { DomainError } from '../src/domain/shared/domain-error';

describe('WagerTransaction', () => {
  const create = (kind: 'BET' | 'REFUND' | 'ROLLBACK' = 'BET', referenceExternalTransactionId?: string) => WagerTransaction.create({
    providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'key-1',
    playerId: 'player-1', walletId: 'wallet-1', roundId: 'round-1', gameId: 'game-1', kind,
    money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId, payloadHash: 'a'.repeat(64),
  });

  it.each(['REFUND', 'ROLLBACK'] as const)('%s requires a reference', (kind) => {
    expect(() => create(kind)).toThrow(DomainError);
  });
  it('rejects OPENING as a provider submitted transaction', () => {
    expect(() => WagerTransaction.create({
      providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'key-1',
      playerId: 'player-1', walletId: 'wallet-1', roundId: 'round-1', gameId: 'game-1', kind: 'OPENING',
      money: { amount: '10.00', currency: 'BRL' }, payloadHash: 'a'.repeat(64),
    })).toThrow(DomainError);
  });
  it('supports valid lifecycle transitions and prevents terminal mutation', () => {
    const transaction = create();
    expect(transaction.value.status).toBe('PROCESSING');
    const processed = transaction.processed(Money.from({ amount: '90.00', currency: 'BRL' }));
    expect(processed.value.status).toBe('PROCESSED');
    expect(() => processed.rejected('INSUFFICIENT_FUNDS')).toThrow(DomainError);
  });
  it('allows a pending reference to resolve or fail exactly once', () => {
    const pending = create('REFUND', 'bet-1').pendingReference();
    expect(pending.value.status).toBe('PENDING_REFERENCE');
    expect(pending.processed(Money.from({ amount: '100.00', currency: 'BRL' })).value.status).toBe('PROCESSED');
    expect(pending.failed('REFERENCE_NOT_FOUND_EXPIRED').value.status).toBe('FAILED');
  });
});
