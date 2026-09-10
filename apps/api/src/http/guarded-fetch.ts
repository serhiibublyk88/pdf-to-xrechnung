import type { UntrustedBoundaryError } from '../config/log-redaction';

export interface FetchedBody {
  status: number;
  body: string;
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(combined, { headers: response.headers }).text();
}

export async function fetchBody({
  input,
  init,
  maxBytes,
  onTransportFailure,
}: {
  input: string | URL;
  init: RequestInit;
  maxBytes: number;
  onTransportFailure: () => UntrustedBoundaryError;
}): Promise<FetchedBody> {
  try {
    const response = await fetch(input, init);
    const body = await readBodyWithLimit(response, maxBytes);
    return { status: response.status, body };
  } catch {
    throw onTransportFailure();
  }
}
