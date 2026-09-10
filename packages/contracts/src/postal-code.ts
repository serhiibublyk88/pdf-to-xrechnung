export function isGermanPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value);
}
