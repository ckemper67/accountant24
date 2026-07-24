#!/usr/bin/env python3
"""Line-coverage gate for fetch_prices.py's own test suite.

Stdlib only (trace + compile()'s co_lines()) - no pip in the vendored
interpreter, so coverage.py isn't an option. Mirrors this repo's vitest
coverage gate in spirit: run the tests, measure line coverage, fail below a
threshold. Ratchet the threshold up only, per the repo's testing
conventions - never lower it to make a change pass.

Usage: python3 coverage_check.py
"""
import dis
import sys
import trace
import unittest
from pathlib import Path

THRESHOLD = 99.0  # percent - ratchet up only, never down (see module docstring)

# The one line this can never see covered: `if __name__ == "__main__":
# main()`. It only executes when the script runs as a subprocess (which
# TestScriptEntryPoint in test_fetch_prices.py does exercise), and this
# in-process line tracer has no visibility into a child process. 99% (not
# 100%) accounts for exactly that one line, not a gap in the test suite.

HERE = Path(__file__).resolve().parent
TARGET = HERE / "fetch_prices.py"


def executable_lines(path: Path) -> set[int]:
    """Lines the compiler actually emits bytecode for - functions, module
    level, comprehensions - via dis.findlinestarts() on every nested code
    object. Portable across Python versions (unlike co_lines(), 3.10+
    only) - the vendored interpreter is 3.12, but a contributor's system
    python3 may be older."""
    code = compile(path.read_text(), str(path), "exec")
    lines: set[int] = set()

    def walk(co) -> None:
        for _offset, ln in dis.findlinestarts(co):
            lines.add(ln)
        for const in co.co_consts:
            if hasattr(const, "co_consts"):
                walk(const)

    walk(code)
    return lines


def main() -> None:
    # Discovery has to happen *inside* runfunc too, not before it - it's what
    # first imports fetch_prices.py, and everything module-level (imports,
    # `def` lines, class bodies) only executes once, at that import. Tracing
    # only the runner.run() call would miss all of it.
    def discover_and_run():
        suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py")
        return unittest.TextTestRunner(verbosity=1).run(suite)

    tracer = trace.Trace(count=True, trace=False)
    result = tracer.runfunc(discover_and_run)

    if not result.wasSuccessful():
        print("Tests failed - fix them before coverage means anything.", file=sys.stderr)
        sys.exit(1)

    counts = tracer.results().counts  # {(filename, lineno): hit_count}
    target = str(TARGET)
    covered = {ln for (fn, ln), n in counts.items() if Path(fn).resolve() == TARGET and n > 0 or fn == target and n > 0}

    total = executable_lines(TARGET)
    hit = total & covered
    missed = sorted(total - covered)
    pct = 100.0 * len(hit) / len(total) if total else 100.0

    print(f"\nLine coverage for {TARGET.name}: {pct:.1f}% ({len(hit)}/{len(total)})")
    if missed:
        print(f"Uncovered lines: {', '.join(map(str, missed))}")

    if pct + 1e-9 < THRESHOLD:
        print(f"ERROR: coverage {pct:.1f}% is below the {THRESHOLD}% threshold", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
