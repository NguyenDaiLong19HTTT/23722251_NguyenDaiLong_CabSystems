/** Public Vietnamese format. Keep legacy +84 as the stable private lookup format. */
const domestic = /^0[0-9]{9}$/;
const legacy = /^\+84[0-9]{9}$/;
// Existing demo records with one extra digit cannot be mapped to a 10-digit
// domestic number without inventing or discarding data. Read-only exception.
const overlengthLegacy = /^\+84[0-9]{10}$/;

export function isDomesticPhone(value: unknown): value is string {
  return typeof value === 'string' && domestic.test(value);
}

export function canonicalPhone(value: string): string {
  if (domestic.test(value)) return `+84${value.slice(1)}`;
  if (legacy.test(value)) return value;
  throw new Error('Invalid Vietnamese phone');
}

export function publicPhone(value: string): string {
  if (overlengthLegacy.test(value)) return value;
  return `0${canonicalPhone(value).slice(3)}`;
}
