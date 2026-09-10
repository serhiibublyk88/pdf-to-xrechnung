import { isPlausibleEmail, isPlausiblePhone } from './contact';

describe('isPlausibleEmail', () => {
  it('accepts a plausible address', () => {
    expect(isPlausibleEmail('buchhaltung@example.de')).toBe(true);
  });

  it('rejects a value with no @', () => {
    expect(isPlausibleEmail('buchhaltung.example.de')).toBe(false);
  });

  it('rejects a value with no domain dot', () => {
    expect(isPlausibleEmail('buchhaltung@example')).toBe(false);
  });

  it('rejects a value with a space', () => {
    expect(isPlausibleEmail('buchhaltung @example.de')).toBe(false);
  });

  it('rejects a value with more than one @', () => {
    expect(isPlausibleEmail('buchhaltung@@example.de')).toBe(false);
    expect(isPlausibleEmail('a@b@example.de')).toBe(false);
  });

  it('rejects leading or trailing whitespace', () => {
    expect(isPlausibleEmail(' buchhaltung@example.de')).toBe(false);
    expect(isPlausibleEmail('buchhaltung@example.de ')).toBe(false);
  });

  it('rejects trailing prose after the address', () => {
    expect(isPlausibleEmail('buchhaltung@example.de please respond')).toBe(
      false,
    );
  });
});

describe('isPlausiblePhone', () => {
  it('accepts a German landline with formatting characters', () => {
    expect(isPlausiblePhone('+49 (30) 123456')).toBe(true);
  });

  it('accepts a plain digit string at the minimum length', () => {
    expect(isPlausiblePhone('123456')).toBe(true);
  });

  it('rejects fewer than six digits', () => {
    expect(isPlausiblePhone('+49 123')).toBe(false);
  });

  it('rejects letters', () => {
    expect(isPlausiblePhone('call 123456')).toBe(false);
  });

  it('rejects five digits, one below the minimum', () => {
    expect(isPlausiblePhone('12345')).toBe(false);
  });

  it('accepts six digits, the minimum', () => {
    expect(isPlausiblePhone('123456')).toBe(true);
  });

  it.each(['+', '(', ')', '-', ' '])(
    'accepts the allowed punctuation character %s alongside six digits',
    (character) => {
      expect(isPlausiblePhone(`123456${character}`)).toBe(true);
    },
  );

  it('rejects a forbidden slash', () => {
    expect(isPlausiblePhone('123/456')).toBe(false);
  });

  it('rejects trailing letters', () => {
    expect(isPlausiblePhone('123456x')).toBe(false);
  });
});
