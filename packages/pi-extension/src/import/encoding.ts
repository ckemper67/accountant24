// Encoding detection and decoding for bank CSV exports.
//
// Strategy:
//   1. Strip a UTF-8 BOM if present.
//   2. Attempt strict UTF-8 decode (TextDecoder fatal mode).
//   3. On failure, fall back to windows-1252 (a superset of latin-1 that covers
//      German umlauts and other Western European characters commonly found in
//      bank exports). TextDecoder('windows-1252') never throws -- every byte is
//      defined in that codepage.
//
// UTF-16 is not supported: a UTF-16 file fails the strict UTF-8 decode and falls
// through to windows-1252, producing garbled text -- a file format issue the caller
// (and its "does not look like CSV" error) will surface.

export interface DecodeResult {
  text: string;
  encoding: "utf-8" | "windows-1252";
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Strip a leading UTF-8 BOM from the buffer, returning the BOM-free slice. */
function stripBom(buf: Uint8Array): Uint8Array {
  if (buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2]) {
    return buf.subarray(3);
  }
  return buf;
}

/**
 * Decode a raw file buffer to a string.
 *
 * Tries strict UTF-8 first. On decode failure falls back to windows-1252.
 * Returns the decoded text and the encoding that succeeded.
 */
export function decodeBuffer(buf: Buffer | Uint8Array): DecodeResult {
  const bytes = buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
  const stripped = stripBom(bytes);

  // Strict UTF-8 -- will throw on any invalid byte sequence.
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(stripped);
    return { text, encoding: "utf-8" };
  } catch {
    // Fall through to windows-1252.
  }

  // windows-1252 -- every byte is defined; never throws.
  const decoder = new TextDecoder("windows-1252");
  const text = decoder.decode(stripped);
  return { text, encoding: "windows-1252" };
}
