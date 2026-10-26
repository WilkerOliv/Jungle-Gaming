import { randomUUID } from 'node:crypto';
import { DomainError } from '../shared/domain-error';
import { Money, MoneyProps } from '../money/money';

export interface WalletState { id: string; playerId: string; balance: MoneyProps; version: number; }

export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static create(playerId: string, initialBalance: Money): Wallet {
    if (!playerId.trim()) throw new DomainError('INVALID_PLAYER', 'playerId is required.');
    if (initialBalance.isNegative()) throw new DomainError('INVALID_INITIAL_BALANCE', 'Initial balance cannot be negative.');
    return new Wallet({ id: randomUUID(), playerId, balance: initialBalance.toJSON(), version: 1 });
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet({ ...state, balance: { ...state.balance } }); }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get balance(): Money { return Money.rehydrate(this.state.balance); }
  get version(): number { return this.state.version; }
  debit(amount: Money): { before: Money; after: Money; next: Wallet } {
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Debit amount must be positive.');
    const before = this.balance;
    const after = before.subtract(amount);
    if (after.isNegative()) throw new DomainError('INSUFFICIENT_FUNDS', 'Wallet has insufficient funds.');
    return { before, after, next: Wallet.rehydrate({ ...this.state, balance: after.toJSON(), version: this.state.version + 1 }) };
  }
  credit(amount: Money): { before: Money; after: Money; next: Wallet } {
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Credit amount must be positive.');
    const before = this.balance;
    const after = before.add(amount);
    return { before, after, next: Wallet.rehydrate({ ...this.state, balance: after.toJSON(), version: this.state.version + 1 }) };
  }
  toState(): WalletState { return { ...this.state, balance: { ...this.state.balance } }; }
}
