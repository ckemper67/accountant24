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

/** Collect existing `date\tcommodity` keys from a prices.journal body. */
function existingKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const m = /^P\s+(\d{4}-\d{2}-\d{2})\s+(\S+)/.exec(line);
    if (m) keys.add(`${m[1]}\t${m[2]}`);
  }
  return keys;
}

export async function writePrices(entries: PriceEntry[], signal?: AbortSignal): Promise<WritePricesResult> {
  const pricesPath = resolveSafePath("prices.journal", LEDGER_DIR);
  const oldContent = existsSync(pricesPath) ? readFileSync(pricesPath, "utf-8") : "";

  const seen = existingKeys(oldContent);
  const newLines: string[] = [];
  let skipped = 0;

  for (const entry of entries) {
    for (const point of entry.points) {
      const key = `${point.date}\t${entry.commodity}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      newLines.push(formatPriceDirective(point.date, entry.commodity, point.close, entry.currency));
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

  declareMissingCommodities(entries);
  ensurePricesIncluded();

  const ledgerIsValid = await validate(signal);
  const diff = generateDiffString(oldContent, newContent).diff;

  return { pricesAdded: newLines.length, skipped, ledgerIsValid, diff };
}

/**
 * Declare any commodity or quote currency not yet in commodities.journal.
 * Under `hledger check --strict` every commodity used in a `P` directive must
 * be declared. Reuses the same matching approach as ../transactions.ts.
 */
function declareMissingCommodities(entries: PriceEntry[]): void {
  const symbols = new Set<string>();
  for (const entry of entries) {
    symbols.add(entry.commodity);
    symbols.add(entry.currency);
  }

  const commoditiesPath = resolveSafePath("commodities.journal", LEDGER_DIR);
  const content = existsSync(commoditiesPath) ? readFileSync(commoditiesPath, "utf-8") : "";
  const missing: string[] = [];
  for (const sym of symbols) {
    const pattern = new RegExp(`^commodity\\s+.*${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    if (!pattern.test(content)) missing.push(sym);
  }

  if (missing.length > 0) {
    const declarations = missing.map((c) => `commodity ${c}`).join("\n");
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    writeFileSync(commoditiesPath, `${content}${sep}${declarations}\n`);
  }
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
