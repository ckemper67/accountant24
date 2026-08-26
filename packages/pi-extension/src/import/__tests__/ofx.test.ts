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
                <AVAILBAL>
                    <BALAMT>1999.99
                    <DTASOF>20250131000000[-8:PST]
                </AVAILBAL>
                <LEDGERBAL>
                    <BALAMT>1954.50
                    <DTASOF>20250131000000[-8:PST]
                </LEDGERBAL>
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

describe("parseOfx() ledgerBalance", () => {
  test("should extract BALAMT and DTASOF from LEDGERBAL, not AVAILBAL", () => {
    const { ledgerBalance } = parseOfx(SAMPLE_OFX);
    // AVAILBAL is 1999.99 in the fixture -- reading it instead would silently pass a
    // different number through as the "ledger" balance.
    expect(ledgerBalance?.amount).toBe("1954.50");
    expect(ledgerBalance?.asOfDate).toBe("2025-01-31");
  });

  test("should keep the balance amount as a raw string, not a parsed number", () => {
    const { ledgerBalance } = parseOfx(SAMPLE_OFX);
    expect(typeof ledgerBalance?.amount).toBe("string");
  });

  test("should convert a DTASOF with a timezone suffix to ISO YYYY-MM-DD", () => {
    const ofx = SAMPLE_OFX.replace(
      "<DTASOF>20250131000000[-8:PST]\n                </LEDGERBAL>",
      "<DTASOF>20250131\n                </LEDGERBAL>",
    );
    const { ledgerBalance } = parseOfx(ofx);
    expect(ledgerBalance?.asOfDate).toBe("2025-01-31");
  });

  test("should return undefined when LEDGERBAL is absent", () => {
    const noBalance = SAMPLE_OFX.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>\n/, "");
    const { ledgerBalance } = parseOfx(noBalance);
    expect(ledgerBalance).toBeUndefined();
  });

  test("should return undefined when LEDGERBAL is present but BALAMT is missing", () => {
    const noAmount = SAMPLE_OFX.replace(
      "<BALAMT>1954.50\n                    <DTASOF>20250131000000[-8:PST]",
      "<DTASOF>20250131000000[-8:PST]",
    );
    const { ledgerBalance } = parseOfx(noAmount);
    expect(ledgerBalance).toBeUndefined();
  });

  test("should return undefined, not throw, when DTASOF is malformed", () => {
    const badDate = SAMPLE_OFX.replace(
      "<LEDGERBAL>\n                    <BALAMT>1954.50\n                    <DTASOF>20250131000000[-8:PST]",
      "<LEDGERBAL>\n                    <BALAMT>1954.50\n                    <DTASOF>notadate",
    );
    expect(() => parseOfx(badDate)).not.toThrow();
    const { ledgerBalance } = parseOfx(badDate);
    expect(ledgerBalance).toBeUndefined();
  });

  test("should still return transaction rows when the balance is malformed", () => {
    const badDate = SAMPLE_OFX.replace(
      "<LEDGERBAL>\n                    <BALAMT>1954.50\n                    <DTASOF>20250131000000[-8:PST]",
      "<LEDGERBAL>\n                    <BALAMT>1954.50\n                    <DTASOF>notadate",
    );
    const { rows } = parseOfx(badDate);
    expect(rows).toHaveLength(2);
  });
});

describe("parseOfx() accountKind", () => {
  test("should return 'bank' for a single BANKACCTFROM block", () => {
    const { accountKind } = parseOfx(SAMPLE_OFX);
    expect(accountKind).toBe("bank");
  });

  test("should return 'cc' for a single CCACCTFROM block", () => {
    const cc = `<OFX><CCACCTFROM><ACCTID>CARD1</ACCTID></CCACCTFROM></OFX>`;
    const { accountKind } = parseOfx(cc);
    expect(accountKind).toBe("cc");
  });

  test("should return undefined when no account block is present", () => {
    const { accountKind } = parseOfx("<OFX></OFX>");
    expect(accountKind).toBeUndefined();
  });

  test("should return undefined when more than one account block is present", () => {
    const twoAccounts = `<OFX>
      <BANKACCTFROM><BANKID>111</BANKID><ACCTID>AAA</ACCTID></BANKACCTFROM>
      <BANKACCTFROM><BANKID>222</BANKID><ACCTID>BBB</ACCTID></BANKACCTFROM>
    </OFX>`;
    const { accountKind } = parseOfx(twoAccounts);
    expect(accountKind).toBeUndefined();
  });
});

describe("parseOfx() statementEndDate", () => {
  test("should extract DTEND from BANKTRANLIST as ISO YYYY-MM-DD", () => {
    const { statementEndDate } = parseOfx(SAMPLE_OFX);
    expect(statementEndDate).toBe("2025-01-31");
  });

  test("should return undefined when BANKTRANLIST is absent", () => {
    const { statementEndDate } = parseOfx("<OFX></OFX>");
    expect(statementEndDate).toBeUndefined();
  });

  test("should return undefined when BANKTRANLIST is present but DTEND is absent", () => {
    const noEnd = SAMPLE_OFX.replace("<DTEND>20250131000000[-8:PST]\n", "");
    const { statementEndDate } = parseOfx(noEnd);
    expect(statementEndDate).toBeUndefined();
  });
});

describe("parseOfx() statementCurrency", () => {
  test("should return the CURDEF value", () => {
    const { statementCurrency } = parseOfx(SAMPLE_OFX);
    expect(statementCurrency).toBe("USD");
  });

  test("should return undefined when CURDEF is absent", () => {
    const noCurdef = SAMPLE_OFX.replace("<CURDEF>USD\n", "");
    const { statementCurrency } = parseOfx(noCurdef);
    expect(statementCurrency).toBeUndefined();
  });
});
