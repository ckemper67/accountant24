import { describe, expect, it } from "vitest";
import { AsyncMutex } from "../mutex";

/** A promise plus its resolve/reject handles, for driving ordering in tests. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AsyncMutex", () => {
  describe("runExclusive()", () => {
    it("should return the resolved value of the function", async () => {
      const mutex = new AsyncMutex();
      await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
    });

    it("should reject the caller with the function's rejection", async () => {
      const mutex = new AsyncMutex();
      await expect(mutex.runExclusive(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });

    it("should not start the second task until the first has resolved", async () => {
      const mutex = new AsyncMutex();
      const order: string[] = [];
      const gate = deferred();

      const first = mutex.runExclusive(async () => {
        order.push("first:start");
        await gate.promise;
        order.push("first:end");
      });
      const second = mutex.runExclusive(async () => {
        order.push("second:start");
      });

      // Give microtasks a chance: the second task must still be blocked.
      await Promise.resolve();
      expect(order).toEqual(["first:start"]);

      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(["first:start", "first:end", "second:start"]);
    });

    it("should still run the next task after the previous one rejects", async () => {
      const mutex = new AsyncMutex();
      const order: string[] = [];

      const first = mutex.runExclusive(async () => {
        order.push("first");
        throw new Error("first failed");
      });
      const second = mutex.runExclusive(async () => {
        order.push("second");
        return "ok";
      });

      await expect(first).rejects.toThrow("first failed");
      await expect(second).resolves.toBe("ok");
      expect(order).toEqual(["first", "second"]);
    });

    it("should run queued tasks in FIFO order", async () => {
      const mutex = new AsyncMutex();
      const order: number[] = [];

      const tasks = [0, 1, 2, 3, 4].map((n) =>
        mutex.runExclusive(async () => {
          await Promise.resolve();
          order.push(n);
        }),
      );

      await Promise.all(tasks);
      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it("should isolate callers: one rejection does not reject later waiters", async () => {
      const mutex = new AsyncMutex();

      const results = await Promise.allSettled([
        mutex.runExclusive(async () => "a"),
        mutex.runExclusive(async () => Promise.reject(new Error("b failed"))),
        mutex.runExclusive(async () => "c"),
      ]);

      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect(results[0]).toMatchObject({ value: "a" });
      expect(results[2]).toMatchObject({ value: "c" });
    });

    it("should serialize a second batch queued after the first drains", async () => {
      const mutex = new AsyncMutex();
      const order: string[] = [];

      await mutex.runExclusive(async () => {
        order.push("one");
      });
      await mutex.runExclusive(async () => {
        order.push("two");
      });

      expect(order).toEqual(["one", "two"]);
    });
  });
});
