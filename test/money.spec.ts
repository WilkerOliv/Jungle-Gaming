import { DomainError } from '../src/domain/shared/domain-error';
import { Money } from '../src/domain/money/money';

describe('Money', () => {
  it('adds and subtracts exactly without floating-point rounding', () => {
    const one = Money.from({ amount: '0.10', currency: 'BRL' });
    const two = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(one.add(two).toString()).toBe('0.30');
    expect(two.subtract(one).toString()).toBe('0.10');
  });
  it.each(['1', '1.0', '1.000', '-1.00', '1e2', 'NaN', ''])('rejects invalid input %s', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(DomainError);
  });
  it('rejects arithmetic across currencies', () => {
    try {
      Money.from({ amount: '1.00', currency: 'BRL' }).add(Money.from({ amount: '1.00', currency: 'USD' }));
      throw new Error('Expected a currency mismatch.');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('CURRENCY_MISMATCH');
    }
  });
  it('supports signed values created by arithmetic and persistence rehydration', () => {
    const negative = Money.zero('BRL').subtract(Money.from({ amount: '0.01', currency: 'BRL' }));
    expect(negative.toString()).toBe('-0.01');
    expect(Money.rehydrate(negative.toJSON()).equals(negative)).toBe(true);
  });
  it('rejects missing data instead of leaking a runtime type error', () => {
    expect(() => Money.from(undefined as never)).toThrow(DomainError);
  });
});
