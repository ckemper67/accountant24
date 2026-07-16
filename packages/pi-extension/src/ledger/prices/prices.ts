import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../../config";
import { HledgerCommandError, hledgerCheck } from "../hledger";
import { resolveSafePath } from "../paths";
import type { PricePoint } from "./yahoo";

// Appends deduplicated hledger `P` price directives to ledger/prices.journal,
// keeping the ledger strict-valid. Pure file/ledger logic — no network (the
// price points are fetched by the caller via ./yahoo). Mirrors the write
// pipeline in ../transactions.ts (commodity declaration, main.journal include,
// hledger check, diff).

export interface PriceEntry {
  /** Ledger commodity symbol, e.g. "VTSAX". */
  commodity: string;
  /** Quote currency, e.g. "USD". */
  currency: string;
  points: PricePoint[];
}

export interface WritePricesResult {
  pricesAdded: number;
  /** Datapoints skipped because a (date, commodity) pair was already present. */
  skipped: number;
  ledgerIsValid: boolean;
  diff: string;
}

/**
 * Format a `P` directive: `P <date> <commodity> <price> <currency>`.
 * Prices are rendered with 2-4 decimal places (trailing zeros beyond the 2nd
 * decimal trimmed).
 */
export function formatPriceDirective(date: string, commodity: string, close: number, currency: string): string {
  return `P ${date} ${commodity} ${formatPrice(close)} ${currency}`;
}

function formatPrice(n: number): string {
  const trimmed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const [intPart, frac = ""] = trimmed.split(".");
  return `${intPart}.${frac.padEnd(2, "0")}`;
}

/** Strip a single pair of surrounding double quotes, if present. */
function bareName(symbol: string): string {
  const m = /^"(.*)"$/.exec(symbol);
  return m ? m[1] : symbol;
}

/**
 * Collect existing `date\tcommodity` keys from a prices.journal body. The
 * commodity is normalized to its unquoted form so that `"FDRXX"` and `FDRXX`
 * dedupe against each other rather than being treated as distinct commodities.
 */
function existingKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    // Commodity is either a quoted string ("A B") or a run of non-space chars.
    const m = /^P\s+(\d{4}-\d{2}-\d{2})\s+("[^"]+"|\S+)/.exec(line);
    if (m) keys.add(`${m[1]}\t${bareName(m[2])}`);
  }
  return keys;
}

/**
 * Extract the commodity symbol from a `commodity` directive's argument (the
 * text after the `commodity` keyword). Handles the amount-style format
 * (`1.000 USD`), a bare symbol (`USD`), and quoted names (`"VANG_TARGET_2030"`).
 * Returns [bare, declaredForm] where `declaredForm` preserves any quoting so we
 * can render `P` lines identically to how the commodity is declared.
 */
function parseCommodityDeclaration(arg: string): { bare: string; declaredForm: string } | null {
  const quoted = /"([^"]+)"/.exec(arg);
  if (quoted) return { bare: quoted[1], declaredForm: quoted[0] };
  for (const token of arg.trim().split(/\s+/)) {
    // Skip the numeric amount (e.g. `1.000`, `1,000.00`); the symbol is the
    // first token that is not purely a number. Require a leading digit so a
    // symbol like `.5X` or punctuation runs are not mistaken for an amount.
    if (!/^[-+]?\d[\d.,]*$/.test(token)) return { bare: token, declaredForm: token };
  }
  return null;
}

/**
 * Map of every declared commodity's unquoted name to the exact form it was
 * declared with (quoted or not), read from commodities.journal.
 */
function declaredCommodities(): Map<string, string> {
  const commoditiesPath = resolveSafePath("commodities.journal", LEDGER_DIR);
  const content = existsSync(commoditiesPath) ? readFileSync(commoditiesPath, "utf-8") : "";
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const m = /^\s*commodity\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const parsed = parseCommodityDeclaration(m[1]);
    if (parsed) map.set(parsed.bare, parsed.declaredForm);
  }
  return map;
}

export async function writePrices(entries: PriceEntry[], signal?: AbortSignal): Promise<WritePricesResult> {
  // Reject any commodity that is not already declared in the ledger, before
  // writing anything. This is the guard against a caller passing a Yahoo ticker
  // (e.g. VTHRX) where the ledger commodity symbol (VANG_TARGET_2030) belongs:
  // such a mistake would otherwise silently create a phantom commodity with no
  // holdings. Only the quote currency is allowed to be auto-declared.
  const declared = declaredCommodities();
  const unknown = [...new Set(entries.map((e) => bareName(e.commodity)).filter((c) => !declared.has(c)))];
  if (unknown.length > 0) {
    const valid = [...declared.keys()].sort().join(", ");
    throw new Error(
      `Unknown commodity: ${unknown.join(", ")}. ` +
        `The \`commodity\` must be a symbol already declared in the ledger, not a Yahoo ticker. ` +
        `Declared commodities: ${valid}.`,
    );
  }

  const pricesPath = resolveSafePath("prices.journal", LEDGER_DIR);
  const oldContent = existsSync(pricesPath) ? readFileSync(pricesPath, "utf-8") : "";

  const seen = existingKeys(oldContent);
  const newLines: string[] = [];
  let skipped = 0;

  for (const entry of entries) {
    // Render both commodity and currency in their declared form so quoting
    // matches commodities.journal. An undeclared currency falls back to its
    // bare name, which is exactly what declareMissingCurrencies will write.
    const bare = bareName(entry.commodity);
    const symbol = declared.get(bare) ?? bare;
    const currency = declared.get(bareName(entry.currency)) ?? bareName(entry.currency);
    for (const point of entry.points) {
      const key = `${point.date}\t${bare}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      newLines.push(formatPriceDirective(point.date, symbol, point.close, currency));
    }
  }

  // Sort by date, then commodity, for stable, readable journals.
  newLines.sort((a, b) => a.localeCompare(b));

  let newContent = oldContent;
  if (newLines.length > 0) {
    const sep = oldContent.length === 0 || oldContent.endsWith("\n") ? "" : "\n";
    newContent = `${oldContent}${sep}${newLines.join("\n")}\n`;
    writeFileSync(pricesPath, newContent);
  }

  declareMissingCurrencies(entries);
  ensurePricesIncluded();

  const ledgerIsValid = await validate(signal);
  const diff = generateDiffString(oldContent, newContent).diff;

  return { pricesAdded: newLines.length, skipped, ledgerIsValid, diff };
}

/**
 * Declare any quote currency not yet in commodities.journal. Under
 * `hledger check --strict` every commodity used in a `P` directive must be
 * declared. Commodities themselves are validated up front (see writePrices) and
 * must already exist, so only the currency side can need auto-declaration.
 */
function declareMissingCurrencies(entries: PriceEntry[]): void {
  const declared = declaredCommodities();
  const missing = [...new Set(entries.map((e) => bareName(e.currency)).filter((c) => !declared.has(c)))];
  if (missing.length === 0) return;

  const commoditiesPath = resolveSafePath("commodities.journal", LEDGER_DIR);
  const content = existsSync(commoditiesPath) ? readFileSync(commoditiesPath, "utf-8") : "";
  const declarations = missing.map((c) => `commodity ${c}`).join("\n");
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(commoditiesPath, `${content}${sep}${declarations}\n`);
}

/** Ensure main.journal includes prices.journal (for pre-existing workspaces). */
function ensurePricesIncluded(): void {
  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  if (!existsSync(mainPath)) return;

  const content = readFileSync(mainPath, "utf-8");
  if (content.includes("include prices.journal")) return;

  const sep = content.endsWith("\n") ? "" : "\n";
  writeFileSync(mainPath, `${content}${sep}include prices.journal\n`);
}

async function validate(signal?: AbortSignal): Promise<boolean> {
  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  try {
    await hledgerCheck(mainPath, { cwd: ACCOUNTANT24_HOME, signal });
    return true;
  } catch (e) {
    if (e instanceof HledgerCommandError) {
      throw new Error(`Prices saved to prices.journal but the ledger has errors:\n\n${e.stderr}`);
    }
    throw e;
  }
}
