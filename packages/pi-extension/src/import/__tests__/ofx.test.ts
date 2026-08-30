import { describe, expect, test } from "vitest";
import { looksLikeOfx, parseOfx } from "../ofx";

const SAMPLE_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
    <SIGNONMSGSRSV1>
        <SONRS>
            <STATUS>
                <CODE>0
                <SEVERITY>INFO
            </STATUS>
            <DTSERVER>20250201000000[-8:PST]
            <LANGUAGE>ENG
        </SONRS>
    </SIGNONMSGSRSV1>
    <BANKMSGSRSV1>
        <STMTTRNRS>
            <TRNUID>0
            <STATUS>
                <CODE>0
                <SEVERITY>INFO
            </STATUS>
            <STMTRS>
                <CURDEF>USD
                <BANKACCTFROM>
                    <BANKID>123456789
                    <ACCTID>0001112223
                    <ACCTTYPE>CHECKING
                </BANKACCTFROM>
                <BANKTRANLIST>
                    <DTSTART>20250101000000[-8:PST]
                    <DTEND>20250131000000[-8:PST]
                    <STMTTRN>
                        <TRNTYPE>DEBIT
                        <DTPOSTED>20250115120000[-8:PST]
                        <TRNAMT>-45.00
                        <FITID>FITID-001
                        <NAME>Whole Foods
                        <MEMO>Groceries
                    </STMTTRN>
                    <STMTTRN>
                        <TRNTYPE>CREDIT
                        <DTPOSTED>20250116000000[-8:PST]
                        <TRNAMT>2000.00
                        <FITID>FITID-002
                        <NAME>ACME Corp
                        <MEMO>January salary
                    </STMTTRN>
                </BANKTRANLIST>
            </STMTRS>
        </STMTTRNRS>
    </BANKMSGSRSV1>
</OFX>
`;

const SIMPLE_CSV = "Date,Amount,Payee,Description\n2025-01-15,-45.00,Whole Foods,Groceries\n";

describe("looksLikeOfx()", () => {
  test("should return true for text with an OFXHEADER line", () => {
    expect(looksLikeOfx(SAMPLE_OFX)).toBe(true);
  });

  test("should return true for text with an <OFX> root tag but no OFXHEADER", () => {
    expect(looksLikeOfx("<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>")).toBe(true);
  });

  test("should return false for CSV text", () => {
    expect(looksLikeOfx(SIMPLE_CSV)).toBe(false);
  });

  test("should return false for empty text", () => {
    expect(looksLikeOfx("")).toBe(false);
  });
});

describe("parseOfx()", () => {
  test("should extract one row per <STMTTRN> block", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows).toHaveLength(2);
  });

  test("should convert DTPOSTED with a timezone suffix to ISO YYYY-MM-DD", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows[0].date).toBe("2025-01-15");
    expect(rows[1].date).toBe("2025-01-16");
  });

  test("should convert a bare 8-digit DTPOSTED (no timezone) to ISO", () => {
    const ofx = SAMPLE_OFX.replace("<DTPOSTED>20250115120000[-8:PST]", "<DTPOSTED>20250115");
    const { rows } = parseOfx(ofx);
    expect(rows[0].date).toBe("2025-01-15");
  });

  test("should read TRNAMT verbatim as the amount string", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows[0].amount).toBe("-45.00");
    expect(rows[1].amount).toBe("2000.00");
  });

  test("should read NAME as payee and MEMO as description", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows[0].payee).toBe("Whole Foods");
    expect(rows[0].description).toBe("Groceries");
  });

  test("should read FITID as the row's fitid", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows[0].fitid).toBe("FITID-001");
    expect(rows[1].fitid).toBe("FITID-002");
  });

  test("should apply the statement-level CURDEF as the currency for every row", () => {
    const { rows } = parseOfx(SAMPLE_OFX);
    expect(rows[0].currency).toBe("USD");
    expect(rows[1].currency).toBe("USD");
  });

  test("should default description and payee to empty strings when MEMO/NAME are absent", () => {
    const ofx = SAMPLE_OFX.replace(/\s*<NAME>Whole Foods\n/, "\n").replace(/\s*<MEMO>Groceries\n/, "\n");
    const { rows } = parseOfx(ofx);
    expect(rows[0].payee).toBe("");
    expect(rows[0].description).toBe("");
  });

  test("should leave fitid undefined when FITID is absent", () => {
    const ofx = SAMPLE_OFX.replace(/\s*<FITID>FITID-001\n/, "\n");
    const { rows } = parseOfx(ofx);
    expect(rows[0].fitid).toBeUndefined();
  });

  test("should count one account block for a single BANKACCTFROM", () => {
    const { accountCount } = parseOfx(SAMPLE_OFX);
    expect(accountCount).toBe(1);
  });

  test("should count two account blocks when the file has two BANKACCTFROM sections", () => {
    const twoAccounts = `<OFX>
      <BANKACCTFROM><BANKID>111</BANKID><ACCTID>AAA</ACCTID></BANKACCTFROM>
      <BANKACCTFROM><BANKID>222</BANKID><ACCTID>BBB</ACCTID></BANKACCTFROM>
    </OFX>`;
    const { accountCount } = parseOfx(twoAccounts);
    expect(accountCount).toBe(2);
  });

  test("should count a CCACCTFROM (credit card) block same as a BANKACCTFROM", () => {
    const cc = `<OFX><CCACCTFROM><ACCTID>CARD1</ACCTID></CCACCTFROM></OFX>`;
    const { accountCount } = parseOfx(cc);
    expect(accountCount).toBe(1);
  });

  test("should throw a descriptive error when a STMTTRN block is missing DTPOSTED or TRNAMT", () => {
    const malformed = SAMPLE_OFX.replace("<DTPOSTED>20250115120000[-8:PST]\n", "");
    expect(() => parseOfx(malformed)).toThrow(/Malformed <STMTTRN>/);
  });

  test("should throw when DTPOSTED does not start with 8 digits", () => {
    const badDate = SAMPLE_OFX.replace("<DTPOSTED>20250115120000[-8:PST]", "<DTPOSTED>notadate");
    expect(() => parseOfx(badDate)).toThrow(/Cannot parse OFX date/);
  });

  test("should return no rows for text with no STMTTRN blocks", () => {
    const { rows } = parseOfx("<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>");
    expect(rows).toHaveLength(0);
  });
});

// A real bank's irregular whitespace: deep space-indentation, tab-indented STMTTRN blocks
// (some banks mix tabs and spaces across an export), and a blank line between blocks and
// between BANKTRANLIST's DTEND and the first STMTTRN. None of this trips the parser today
// -- extractLeaf searches for the tag anywhere in the text rather than anchoring to line
// position -- but it is exactly the kind of real-world irregularity a future refactor
// (e.g. switching to a line-anchored parser) could silently break, so it is locked in here
// as a fixture rather than left as an untested assumption. Data is fictional.
const INDENTED_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
    <BANKMSGSRSV1>
        <STMTTRNRS>
            <STMTRS>
                <CURDEF>USD
                <BANKACCTFROM>
                    <BANKID>111000025
                    <ACCTID>0009998887
                    <ACCTTYPE>CHECKING
                    </BANKACCTFROM>

                <BANKTRANLIST>
                    <DTSTART>20240301000000[-8:PST]
                    <DTEND>20240828000000[-8:PST]

                      <STMTTRN>
                            <TRNTYPE>CREDIT
                            <DTPOSTED>20240828000000[-8:PST]
                            <TRNAMT>500.00
                            <FITID>20240828000000[-8:PST]*500.00*512**Example Deposit Co,
\t\t\t\t\t\t\t<NAME>Example Deposit Co,
\t\t\t\t\t\t\t<MEMO>Invoice - 0000000001
                      </STMTTRN>

\t\t\t\t\t  <STMTTRN>
                            <TRNTYPE>DEBIT
                            <DTPOSTED>20240826000000[-8:PST]
                            <TRNAMT>-40.00
                            <FITID>20240826000000[-8:PST]*-40.00*12**Example Utility Co
\t\t\t\t\t\t\t<NAME>Example Utility Co
\t\t\t\t\t\t\t<MEMO>AUTO BILL PAY SERVICE - PAYMENT
                      </STMTTRN>
                </BANKTRANLIST>
            </STMTRS>
        </STMTTRNRS>
    </BANKMSGSRSV1>
</OFX>
`;

describe("parseOfx() irregular real-world whitespace", () => {
  test("should extract one row per STMTTRN despite blank lines between blocks", () => {
    const { rows } = parseOfx(INDENTED_OFX);
    expect(rows).toHaveLength(2);
  });

  test("should read fields correctly under tab-indented NAME/MEMO lines", () => {
    const { rows } = parseOfx(INDENTED_OFX);
    expect(rows[0].date).toBe("2024-08-28");
    expect(rows[0].amount).toBe("500.00");
    expect(rows[0].payee).toBe("Example Deposit Co,");
    expect(rows[0].description).toBe("Invoice - 0000000001");
    expect(rows[1].date).toBe("2024-08-26");
    expect(rows[1].amount).toBe("-40.00");
  });

  test("should still count the account block despite the blank line before BANKACCTFROM's close", () => {
    const { accountCount } = parseOfx(INDENTED_OFX);
    expect(accountCount).toBe(1);
  });
});
