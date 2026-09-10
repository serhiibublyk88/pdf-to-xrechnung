import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type KositMessageLevel = 'error' | 'warning' | 'information';

export interface KositReportMessage {
  code: string;
  level: KositMessageLevel;
  text: string;
}

export interface KositReport {
  valid: boolean;
  messages: KositReportMessage[];
}

const REPORT_ROOT = 'rep:report';
const MESSAGE_ELEMENT = 'rep:message';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  stopNodes: ['*.rep:assessment'],
});

type XmlNode = Record<string, unknown>;

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function levelOf(value: unknown): KositMessageLevel {
  return value === 'error' || value === 'warning' ? value : 'information';
}

function toMessage(node: XmlNode): KositReportMessage {
  return {
    code: textOf(node['@code']) || textOf(node['@id']) || 'unspecified',
    level: levelOf(node['@level']),
    text: textOf(node['#text']),
  };
}

function collectFromMessageElement(
  value: unknown,
  into: KositReportMessage[],
): void {
  const nodes: unknown[] = Array.isArray(value) ? value : [value];
  for (const node of nodes) {
    if (isXmlNode(node)) {
      into.push(toMessage(node));
    }
  }
}

function collectMessages(node: unknown, into: KositReportMessage[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectMessages(item, into);
    }
    return;
  }
  if (!isXmlNode(node)) {
    return;
  }
  for (const [name, value] of Object.entries(node)) {
    if (name === MESSAGE_ELEMENT) {
      collectFromMessageElement(value, into);
    } else {
      collectMessages(value, into);
    }
  }
}

export function parseKositReport(xml: string): KositReport | null {
  if (XMLValidator.validate(xml) !== true) {
    return null;
  }

  const document: unknown = parser.parse(xml);
  if (!isXmlNode(document)) {
    return null;
  }
  const report = document[REPORT_ROOT];
  if (!isXmlNode(report)) {
    return null;
  }
  const valid = report['@valid'];
  if (valid !== 'true' && valid !== 'false') {
    return null;
  }

  const messages: KositReportMessage[] = [];
  collectMessages(report, messages);
  return { valid: valid === 'true', messages };
}
