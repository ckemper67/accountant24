/**
 * A FIFO async mutex. `runExclusive(fn)` waits for every earlier caller to
 * settle, runs `fn`, then releases -- whether `fn` resolves or rejects.
 *
 * The ledger writers (`add_transactions`, `bulk_edit`, `add_prices`,
 * `add_balance_assertions`, `memory_edit`) are not reentrant against one
 * another or themselves: each reads journal files, edits them, writes the
 * batch, runs a ledger-wide `hledger check`, then commits. In the desktop app
 * pi guarantees they never overlap by registering them
 * `executionMode: "sequential"`. The MCP server has no such scheduler, so it
 * serializes them here -- one writer at a time, the lock held across the check
 * and the commit.
 *
 * Read tools (`query`, `lookup`, `validate`) do not take the lock.
 */
export class AsyncMutex {
  // Resolves when the last-queued caller has settled. Chained, never rejected.
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Start `fn` once `tail` settles, regardless of how it settled.
    const result = this.tail.then(fn, fn);
    // The next caller chains after this one either way; swallow here so one
    // rejected turn does not reject every future waiter.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
