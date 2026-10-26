import { DomainError } from '../shared/domain-error';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** Exact immutable money value backed by integer minor units. */
export class Money {
  private constructor(private readonly minorUnits: bigint, public readonly currency: string) {
    if ((minorUnits < 0n ? -minorUnits : minorUnits) > 99999999999999999999n) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds the supported precision.');
    }
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') throw new DomainError('INVALID_MONEY', 'Money value is required.');
    const currency = typeof props.currency === 'string' ? props.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError('INVALID_CURRENCY', 'Currency must be an ISO-4217 code.');
    if (typeof props.amount !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(props.amount)) {
      throw new DomainError('INVALID_MONEY', 'Amount must be a non-negative decimal string with exactly two fraction digits.');
    }
    const [whole, fraction] = props.amount.split('.');
    if (whole.length > 18) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds the supported precision.');
    return new Money(BigInt(whole) * 100n + BigInt(fraction), currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }

  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') throw new DomainError('INVALID_PERSISTED_MONEY', 'Persisted money value is missing.');
    const currency = typeof props.currency === 'string' ? props.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency) || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(props.amount)) {
      throw new DomainError('INVALID_PERSISTED_MONEY', 'Persisted amount or currency is invalid.');
    }
    const negative = props.amount.startsWith('-');
    const [whole, fraction] = (negative ? props.amount.slice(1) : props.amount).split('.');
    if (whole.length > 18) throw new DomainError('INVALID_PERSISTED_MONEY', 'Persisted amount exceeds the supported precision.');
    const units = BigInt(whole) * 100n + BigInt(fraction);
    return new Money(negative ? -units : units, currency);
  }

  add(other: Money): Money { this.assertSameCurrency(other); return new Money(this.minorUnits + other.minorUnits, this.currency); }
  subtract(other: Money): Money { this.assertSameCurrency(other); return new Money(this.minorUnits - other.minorUnits, this.currency); }
  negate(): Money { return new Money(-this.minorUnits, this.currency); }
  isZero(): boolean { return this.minorUnits === 0n; }
  isPositive(): boolean { return this.minorUnits > 0n; }
  isNegative(): boolean { return this.minorUnits < 0n; }
  isLessThan(other: Money): boolean { this.assertSameCurrency(other); return this.minorUnits < other.minorUnits; }
  equals(other: Money): boolean { return this.currency === other.currency && this.minorUnits === other.minorUnits; }
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string {
    const sign = this.minorUnits < 0n ? '-' : '';
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH', `Cannot combine ${this.currency} with ${other.currency}.`);
  }
}
