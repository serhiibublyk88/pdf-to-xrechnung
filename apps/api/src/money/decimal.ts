import { canonicalDecimalPattern } from '@pdf-to-xrechnung/contracts';

export interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseDecimalString(value: string): Decimal {
  if (!canonicalDecimalPattern.test(value)) {
    throw new Error('Invalid decimal');
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, fractionPart = ''] = unsigned.split('.');
  return {
    coefficient:
      (negative ? -1n : 1n) * BigInt(`${integerPart}${fractionPart}`),
    scale: fractionPart.length,
  };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function roundHalfAwayFromZeroToScale(
  value: Decimal,
  targetScale: number,
): bigint {
  if (value.scale <= targetScale) {
    return value.coefficient * powerOfTen(targetScale - value.scale);
  }

  const divisor = powerOfTen(value.scale - targetScale);
  const absolute =
    value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const rounded = (absolute + divisor / 2n) / divisor;
  return value.coefficient < 0n ? -rounded : rounded;
}

export function toMinorUnits(value: string): bigint {
  return toMinorUnitsFromDecimal(parseDecimalString(value));
}

export function toMinorUnitsFromDecimal(value: Decimal): bigint {
  if (value.scale > 2) {
    throw new Error(
      `Monetary amount has ${value.scale} decimal places, exceeding the allowed 2`,
    );
  }
  return roundHalfAwayFromZeroToScale(value, 2);
}

function multiplyDecimals(left: Decimal, right: Decimal): Decimal {
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

export function productInMinorUnits(left: string, right: string): bigint {
  return productDecimalsInMinorUnits(
    parseDecimalString(left),
    parseDecimalString(right),
  );
}

export function productDecimalsInMinorUnits(
  left: Decimal,
  right: Decimal,
): bigint {
  return roundHalfAwayFromZeroToScale(multiplyDecimals(left, right), 2);
}

export function percentageOfInMinorUnits(base: string, rate: string): bigint {
  return percentageOfDecimalsInMinorUnits(
    parseDecimalString(base),
    parseDecimalString(rate),
  );
}

export function percentageOfDecimalsInMinorUnits(
  base: Decimal,
  rate: Decimal,
): bigint {
  return roundHalfAwayFromZeroToScale(
    {
      coefficient: base.coefficient * rate.coefficient,
      scale: base.scale + rate.scale + 2,
    },
    2,
  );
}

export function canonicalDecimalKey(value: string): string {
  return canonicalDecimalKeyFromDecimal(parseDecimalString(value));
}

export function canonicalDecimalKeyFromDecimal(value: Decimal): string {
  if (value.coefficient === 0n) {
    return '0';
  }

  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return `${coefficient}:${scale}`;
}
