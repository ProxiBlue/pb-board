# Changelog

## 0.3.0 — 2026-11-25

- **Test runs band.** A band above the prompt shows test runs:
  - `🧪 tests: <project> <slots> <elapsed>` for every run on the machine, read
    from a host `tests-running --json` script when one is on `PATH`. It shows
    nothing when the script is missing, and asks again after five minutes.
  - `⚠ test run in this session: … Closing this session kills it.` while a run
    started under this session's own process is going. Runs are found with one
    `ps` every 15 seconds; runner patterns cover Playwright, phpunit/paratest,
    Magento dev:tests:run, pytest, vitest run, jest and yarn/npm/pnpm test.
- **`/exit` asks first** while this session's own test run is going. It lists
  the runs; a second `/exit` within 20 seconds quits. It fails open: any error
  lets `/exit` quit. ctrl+c, ctrl+d and closing the terminal can't be caught.
- The pane gets a **TESTS** section, two rows per run: project, slot, runner and
  elapsed, then owner and command.
- New `hooks/watch.ts` (pure detection and formatting) and tests for it, the
  band and the `/exit` confirmation.

## 0.2.0 — 2026-11-11

- The mod now wires Playwright by itself: at session start it sets
  `PW_TEST_REPORTER` to its bundled reporter for the session's process, so
  test runs Claude starts show on the board with no settings to edit. An
  existing `PW_TEST_REPORTER` is left alone; `PB_BOARD_REPORTER=off` switches
  the wiring off.
- README: Playwright setup rewritten around the automatic wiring; manual
  setup kept for runs the session's environment does not reach.

## 0.1.0 — 2026-11-11

- Initial release: plan, agents and Playwright sections; `/board` command;
  bundled Playwright reporter.
