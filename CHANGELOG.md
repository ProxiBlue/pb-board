# Changelog

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
