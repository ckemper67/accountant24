// Parameter schemas and prompt guidelines shared by import_transactions and
// import_transactions_from_rows -- both feed the same underlying pipeline (see
// ../import/import.ts) and expose the same locale-override and catch-all-account contract.

import { Type } from "typebox";

export const NumberFormatParam = Type.Optional(
  Type.Union(
    [
      Type.Literal("us", { description: "US/UK: 1,234.56 (comma thousands, dot decimal)" }),
      Type.Literal("de", { description: "German: 1.234,56 (dot thousands, comma decimal)" }),
      Type.Literal("fr", { description: "French/SI: 1 234,56 (space/NBSP thousands, comma decimal)" }),
      Type.Literal("ch", { description: "Swiss: 1'234.56 (apostrophe thousands, dot decimal)" }),
    ],
    {
      description:
        "Number format override. Omit to auto-detect. Always specify if the auto-detected " +
        "format is wrong -- a mis-parsed amount silently corrupts the ledger.",
    },
  ),
);

export const DateFormatParam = Type.Optional(
  Type.Union(
    [
      Type.Literal("MDY", { description: "US: MM/DD/YYYY" }),
      Type.Literal("DMY", { description: "EU/German: DD/MM/YYYY or DD.MM.YYYY" }),
    ],
    {
      description:
        "Date order override for ambiguous dates (both components <= 12). Omit to auto-detect. " +
        "IMPORTANT: a mis-parsed date sends the transaction to the wrong monthly file.",
    },
  ),
);

export const UncategorizedExpenseAccountParam = Type.String({
  description:
    "REQUIRED. Existing account that outflow (negative) rows balance to, in the workspace's own naming " +
    "(e.g. expenses:uncategorized) -- take it from the injected account list. The tool does not create " +
    "accounts and fails if it is not declared. If the statement has no outflows, pass any declared expense account.",
});

export const UncategorizedIncomeAccountParam = Type.String({
  description:
    "REQUIRED. Existing account that inflow (positive) rows balance to (e.g. income:uncategorized), from the " +
    "injected account list. For a credit-card/liability statement, point both at an expense catch-all since " +
    "charges are spending, not income. If the statement has no inflows, pass any declared income account.",
});

export const UNCATEGORIZED_ACCOUNTS_GUIDELINE =
  "uncategorized_expense_account and uncategorized_income_account are required: pass accounts that already " +
  "exist in the injected list (the tool does not create accounts). Pick them before calling, even for dry_run.";

export const RECATEGORIZE_GUIDELINE =
  "After import, re-categorize the uncategorized accounts with the modify-transactions skill's bundled " +
  "script (run via bash) - or the edit tool on the monthly journal files if that skill isn't installed in this build.";
