import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKositReport } from './kosit-report';

function fixture(name: string): string {
  return readFileSync(join(__dirname, name), 'utf8');
}

const REJECTED = fixture('kosit-report-rejected.fixture.xml');
const ACCEPTED = fixture('kosit-report-accepted.fixture.xml');

describe('parseKositReport against reports from the real KoSIT validator', () => {
  it('reads a rejection and every rule the validator objected to', () => {
    const report = parseKositReport(REJECTED);

    expect(report?.valid).toBe(false);
    expect(
      report?.messages.map(({ code, level }) => ({ code, level })),
    ).toEqual([
      { code: 'BR-CO-09', level: 'error' },
      { code: 'BR-DE-TMP-32', level: 'information' },
    ]);
    expect(report?.messages[0]?.text).toContain('[BR-CO-09]');
  });

  it('reads an acceptance', () => {
    const report = parseKositReport(ACCEPTED);

    expect(report?.valid).toBe(true);
    expect(report?.messages.some((message) => message.level === 'error')).toBe(
      false,
    );
  });

  it('counts only rep:message elements, not every level attribute in the document', () => {
    expect(REJECTED).toContain('<s:customLevel level="error"');
    expect(REJECTED).toContain('rep:assessment');

    expect(parseKositReport(REJECTED)?.messages).toHaveLength(2);
  });

  it.each([
    ['a body cut off mid-stream', '<rep:report valid="false"><rep:scenario'],
    [
      'an HTML error page',
      '<html><body><h1>502 Bad Gateway</h1></body></html>',
    ],
    ['plain text', 'gateway timeout'],
    ['an empty body', ''],
    ['well-formed XML that is not a report', '<other valid="true"/>'],
  ])('rejects %s as unreadable rather than as a verdict', (_label, body) => {
    expect(parseKositReport(body)).toBeNull();
  });
});
