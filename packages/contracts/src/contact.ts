export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isPlausiblePhone(value: string): boolean {
  if (!/^[+0-9 ()-]+$/.test(value)) {
    return false;
  }
  const digitCount = (value.match(/\d/g) ?? []).length;
  return digitCount >= 6;
}
