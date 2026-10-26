import { Money } from '../src/domain/money/money';
import { Wallet } from '../src/domain/wallet/wallet';
import { DomainError } from '../src/domain/shared/domain-error';

describe('Wallet', () => {
  const initial = () => Money.from({ amount: '100.00', currency: 'BRL' });
  it('debits without mutating its prior state', () => {
    const wallet = Wallet.create('player-1', initial());
    const debit = wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }));
    expect(wallet.balance.toString()).toBe('100.00');
    expect(debit.after.toString()).toBe('20.00');
    expect(debit.next.version).toBe(wallet.version + 1);
  });
  it('refuses a debit that would make the balance negative', () => {
    const wallet = Wallet.create('player-1', initial());
    try {
      wallet.debit(Money.from({ amount: '100.01', currency: 'BRL' }));
      throw new Error('Expected insufficient funds.');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });
  it('rejects currency mismatch and does not change version for an attempted operation', () => {
    const wallet = Wallet.create('player-1', initial());
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(DomainError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
  it('creates an independent next wallet state when crediting', () => {
    const wallet = Wallet.create('player-1', initial());
    const credit = wallet.credit(Money.from({ amount: '0.10', currency: 'BRL' }));
    expect(wallet.balance.toString()).toBe('100.00');
    expect(credit.after.toString()).toBe('100.10');
    expect(credit.next.version).toBe(2);
  });
});
