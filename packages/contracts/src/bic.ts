// ISO 9362's business-party prefix is 4an, not 4a — only the country positions are alphabetic.
const BIC_PATTERN = /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function bicHasValidFormat(value: string): boolean {
  return BIC_PATTERN.test(value.trim().toUpperCase());
}
