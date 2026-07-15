// Encoding detection and decoding for bank CSV exports.
//
// Strategy:
//   1. Strip a BOM if present (UTF-8, UTF-16 LE/BE).
//   2. Attempt strict UTF-8 decode (TextDecoder fatal mode).
//   3. On failure, fall back to windows-1252 (a superset of latin-1 that covers
//      German umlauts and other Western European characters commonly found in
//      bank exports). TextDecoder('windows-1252') never throws -- every byte is
//      defined in that codepage.

export interface DecodeResult {
  text: string;
  encoding: "utf-8" | "windows-1252";
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

/** Strip a leading BOM from the buffer, returning the BOM-free slice. */
function stripBom(buf: Uint8Array): Uint8Array {
  if (buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2]) {
    return buf.subarray(3);
  }
  // UTF-16 BOMs: not stripping bytes here because we only support UTF-8 / windows-1252
  // for CSV. If we get a UTF-16 BOM, let the strict UTF-8 decode fail and fall through
  // to windows-1252 (which will produce garbled text for UTF-16, but that is a file
  // format issue the caller will surface).
  if (
    (buf.length >= 2 && buf[0] === UTF16_LE_BOM[0] && buf[1] === UTF16_LE_BOM[1]) ||
    (buf.length >= 2 && buf[0] === UTF16_BE_BOM[0] && buf[1] === UTF16_BE_BOM[1])
  ) {
    // Pass through; strict UTF-8 will reject the non-UTF-8 bytes.
    return buf;
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
