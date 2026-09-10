import type { Dictionary } from './dictionary';

type Collection = 'lineItems' | 'vatBreakdown';

function isCollection(value: string | undefined): value is Collection {
  return value === 'lineItems' || value === 'vatBreakdown';
}

function isParty(value: string | undefined): value is 'seller' | 'buyer' {
  return value === 'seller' || value === 'buyer';
}

function labelIn(
  labels: Record<string, string>,
  key: string | undefined,
): string | undefined {
  return key === undefined ? undefined : labels[key];
}

const indexedSubfieldPattern = /^(lineItems|vatBreakdown)\[(\d+)\]\.(.+)$/;
const indexedPattern = /^(lineItems|vatBreakdown)\[(\d+)\]$/;
const partySubfieldPattern = /^(seller|buyer)\.(.+)$/;

function parseIndexedMatch(
  match: RegExpExecArray,
): { collection: Collection; indexText: string } | null {
  const [, collection, indexText] = match;
  return isCollection(collection) && indexText !== undefined
    ? { collection, indexText }
    : null;
}

function collectionLabel(
  collection: Collection,
  indexText: string,
  dictionary: Dictionary,
): string {
  const position = Number(indexText) + 1;
  return collection === 'lineItems'
    ? dictionary.review.positionLabel(position)
    : dictionary.review.vatGroupLabel(position);
}

export function formatFieldPath(
  path: string | null,
  dictionary: Dictionary,
): string {
  if (path === null) return dictionary.review.generalFinding;

  const indexedSubfield = indexedSubfieldPattern.exec(path);
  const parsedSubfield = indexedSubfield && parseIndexedMatch(indexedSubfield);
  if (parsedSubfield) {
    const { collection, indexText } = parsedSubfield;
    const subfield = indexedSubfield[3];
    const groupLabel = collectionLabel(collection, indexText, dictionary);
    const fieldLabel = labelIn(
      collection === 'lineItems'
        ? dictionary.lineItem
        : dictionary.vatBreakdownField,
      subfield,
    );
    return fieldLabel ? `${groupLabel} · ${fieldLabel}` : groupLabel;
  }

  const indexed = indexedPattern.exec(path);
  const parsedIndexed = indexed && parseIndexedMatch(indexed);
  if (parsedIndexed) {
    return collectionLabel(
      parsedIndexed.collection,
      parsedIndexed.indexText,
      dictionary,
    );
  }

  const partySubfield = partySubfieldPattern.exec(path);
  if (partySubfield) {
    const [, party, subfield] = partySubfield;
    if (isParty(party)) {
      const fieldLabel = labelIn(dictionary.party, subfield);
      return fieldLabel
        ? `${dictionary.fields[party]} · ${fieldLabel}`
        : dictionary.fields[party];
    }
  }

  const fieldLabel = labelIn(dictionary.fields, path);
  if (fieldLabel) return fieldLabel;
  if (path === 'totals') return dictionary.review.groups.totals;

  return path;
}
