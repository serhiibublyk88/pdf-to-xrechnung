// KoSIT Leitweg-ID spec v2.0.2 §2.4: hyphens are excluded, letters map A=10..Z=35.
const LEITWEG_ID_PATTERN = /^(\d{2,12})(?:-([A-Za-z0-9]{1,30}))?-(\d{2})$/;

export function looksLikeLeitwegId(value: string): boolean {
  return LEITWEG_ID_PATTERN.test(value);
}

export function leitwegIdHasValidChecksum(value: string): boolean {
  const match = LEITWEG_ID_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, coarse, fine = '', checkDigits] = match;
  const digitsOnly = `${coarse}${fine}`
    .toUpperCase()
    .split('')
    .map((character) =>
      /\d/.test(character) ? character : String(character.charCodeAt(0) - 55),
    )
    .join('');

  let remainder = 0;
  for (const digit of `${digitsOnly}00`) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }

  return String(98 - remainder).padStart(2, '0') === checkDigits;
}
