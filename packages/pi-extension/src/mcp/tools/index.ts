import type { McpToolSpec } from "../registry";
import { lookupSpec } from "./lookup";
import { querySpec } from "./query";
import { validateSpec } from "./validate";

/** Read-only tools -- `readOnlyHint: true`, no writer mutex. */
export const READ_ONLY_SPECS: McpToolSpec[] = [querySpec, lookupSpec, validateSpec];
