import { describe, expect, test } from "vitest";
import { decodeBuffer } from "../encoding";

describe("decodeBuffer()", () => {
  describe("UTF-8 detection", () => {
    test("should return utf-8 for plain ASCII", () => {
      const buf = Buffer.from("hello,world", "ascii");
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("hello,world");
    });

    test("should return utf-8 for valid UTF-8 multibyte text", () => {
      const buf = Buffer.from("Muller,Schmidt", "utf-8");
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("Muller,Schmidt");
    });

    test("should strip UTF-8 BOM and return utf-8", () => {
      // UTF-8 BOM: EF BB BF followed by ASCII content.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from("date,amount", "ascii");
      const buf = Buffer.concat([bom, content]);
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("date,amount");
    });

    test("should fall back to windows-1252 on a UTF-16 LE BOM (unsupported for CSV)", () => {
      // UTF-16 LE BOM: FF FE. Not stripped -- left in place so strict UTF-8 rejects it and
      // decoding falls through to windows-1252 (garbled, but a real file-format issue, not
      // something this decoder is meant to fix).
      const bom = Buffer.from([0xff, 0xfe]);
      const content = Buffer.from("d\x00a\x00t\x00e\x00", "binary");
      const buf = Buffer.concat([bom, content]);
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("windows-1252");
    });
  });

  describe("windows-1252 fallback", () => {
    test("should fall back to windows-1252 for latin-1 umlaut bytes", () => {
      // German umlauts in latin-1/windows-1252: ae=0xE4, oe=0xF6, ue=0xFC, sz=0xDF
      // These bytes are invalid in strict UTF-8.
      const buf = Buffer.from([
        0x4d,
        0xfc,
        0x6c,
        0x6c,
        0x65,
        0x72, // Muller (ue=0xFC)
        0x2c,
        0x53,
        0x63,
        0x68,
        0xe4,
        0x64,
        0x65, // Schade (ae=0xE4)
        0x6c,
      ]);
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("windows-1252");
      // windows-1252 0xFC = u-umlaut, 0xE4 = a-umlaut
      expect(result.text).toContain("ü"); // u-umlaut
      expect(result.text).toContain("ä"); // a-umlaut
    });

    test("should fall back to windows-1252 for sharp-s byte 0xDF", () => {
      const buf = Buffer.from([0x53, 0x74, 0x72, 0x61, 0xdf, 0x65]); // Strae with sz
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("windows-1252");
      expect(result.text).toContain("ß"); // sharp-s
    });
  });

  describe("edge cases", () => {
    test("should handle empty buffer as utf-8", () => {
      const result = decodeBuffer(Buffer.alloc(0));
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("");
    });

    test("should accept Buffer subclass", () => {
      const buf = Buffer.from("test", "utf-8");
      const result = decodeBuffer(buf);
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("test");
    });

    test("should accept Uint8Array", () => {
      const arr = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
      const result = decodeBuffer(arr);
      expect(result.encoding).toBe("utf-8");
      expect(result.text).toBe("hello");
    });
  });
});
