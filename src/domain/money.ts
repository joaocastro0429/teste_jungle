import { DomainError } from './errors';
export interface MoneyProps {
  amount: string;
  currency: string;
}
/** Exact integer cents. No conversion through IEEE-754, including persistence. */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }
  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      !/^(0|[1-9]\d{0,15})\.\d{2}$/.test(props.amount)
    )
      throw new DomainError(
        'INVALID_AMOUNT',
        'Use uma string decimal não negativa com duas casas, até 16 dígitos inteiros.',
      );
    if (typeof props.currency !== 'string' || !/^[A-Z]{3}$/.test(props.currency))
      throw new DomainError('INVALID_CURRENCY');
    return new Money(BigInt(props.amount.replace('.', '')), props.currency);
  }
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  static rehydrate(amount: string, currency: string): Money {
    return amount.startsWith('-')
      ? Money.from({ amount: amount.slice(1), currency }).negate()
      : Money.from({ amount, currency });
  }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }
  subtract(other: Money): Money {
    return this.add(other.negate());
  }
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }
  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }
  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
}
