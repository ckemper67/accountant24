import type { McpToolSpec } from "../registry";
import { addBalanceAssertionsSpec } from "./add-balance-assertions";
import { addPricesSpec } from "./add-prices";
import { addTransactionsSpec } from "./add-transactions";
import { bulkEditSpec } from "./bulk-edit";
import { lookupSpec } from "./lookup";
import { memoryEditSpec } from "./memory-edit";
import { querySpec } from "./query";
import { validateSpec } from "./validate";

/** Read-only tools -- `readOnlyHint: true`, no writer mutex. */
export const READ_ONLY_SPECS: McpToolSpec[] = [querySpec, lookupSpec, validateSpec];

/** Writer tools -- each runs its whole cycle inside `writerMutex` and commits
 *  the workspace on success. */
export const WRITER_SPECS: McpToolSpec[] = [
  addTransactionsSpec,
  addBalanceAssertionsSpec,
  addPricesSpec,
  bulkEditSpec,
  memoryEditSpec,
];
