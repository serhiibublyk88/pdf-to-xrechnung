import { encodeRfc5987ValueChars } from './invoices.controller';

describe('encodeRfc5987ValueChars', () => {
  it('escapes the RFC 5987 attr-char exclusions encodeURIComponent leaves untouched', () => {
    expect(encodeRfc5987ValueChars(`O'Brien (draft)*.pdf`)).toBe(
      'O%27Brien%20%28draft%29%2A.pdf',
    );
  });

  it('still percent-encodes everything encodeURIComponent already handles', () => {
    expect(encodeRfc5987ValueChars('Rechnung Müller.pdf')).toBe(
      'Rechnung%20M%C3%BCller.pdf',
    );
  });
});
