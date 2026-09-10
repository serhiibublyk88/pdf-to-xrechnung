export function vatIdHasValidChecksum(vatId: string): boolean {
  const normalized = vatId.replace(/\s+/g, '').toUpperCase();
  if (!/^DE\d{9}$/.test(normalized)) {
    return false;
  }

  let product = 10;
  for (const digit of normalized.slice(2, 10)) {
    let intermediate = (Number(digit) + product) % 10;
    if (intermediate === 0) {
      intermediate = 10;
    }
    product = (2 * intermediate) % 11;
  }

  const checkDigit = 11 - product === 10 ? 0 : 11 - product;
  return Number(normalized[10]) === checkDigit;
}

export function ibanHasValidChecksum(iban: string): boolean {
  const normalized = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalized)) {
    return false;
  }
  if (
    normalized.length < 15 ||
    normalized.length > 34 ||
    (normalized.startsWith('DE') && normalized.length !== 22)
  ) {
    return false;
  }

  const reordered = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;
  for (const character of reordered) {
    const digits = /\d/.test(character)
      ? character
      : String(character.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}
