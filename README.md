# pb-board

A Claude Code **mod** that puts a live progress board in the side pane of the fullscreen terminal UI. It shows three things while Claude works:

- **Plan** — the HCF plan being executed: status, a progress bar, and one row per task with its state and how many of its requirements are ticked.
- **Agents** — the subagents running right now, with how long each has been going.
- **Playwright** — the test run in progress: totals, pass / fail / flaky / skipped counts, the test each worker is on, and the failures so far.

```
PLAN user-authentication            in_progress
2/4 tasks · 8/12 reqs
███████████████████████░░░░░░░░░░░░░
✓ 001 Add users table migration             3/3
✓ 002 Password hashing service              4/4
▶ 003 Login endpoint returns a token        1/3
· 004 Playwright: login flow end to end     0/2

AGENTS                                        1
▶ tdd-worker Task 003 login endpoint       1m04s

PLAYWRIGHT                          running 42s
6/10  ✓5 ✗1 ~0 -0
█████████████████████░░░░░░░░░░░░░░░
▶ w0 profile.spec.ts › avatar › uploads      3s
▶ w1 login.spec.ts › rejects bad password    1s
✗ login.spec.ts › remembers the session      1s
```

The board only watches. It never blocks, rewrites or approves a tool call. The one thing it changes is a single environment variable, so Playwright reports to it — see [Playwright progress](#playwright-progress).

> **Status: 0.1.0, early.** Claude Code's mods API is early access and changes between releases. This was built and tested on Claude Code 2.1.321. See [Limits](#limits).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [Plan progress (HCF)](#plan-progress-hcf)
- [Playwright progress](#playwright-progress)
- [How it works](#how-it-works)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Attributions & licensing](#attributions--licensing)

## Requirements

| What | Needed for | Notes |
| --- | --- | --- |
| **Claude Code 2.1.287 or later** | Everything | The first release with mods. Built and tested on 2.1.321. |
| **Fullscreen terminal UI** | The docked side pane | `/tui fullscreen`. Outside fullscreen the pane still opens, but inline above the prompt instead of beside the transcript. |
| **A wide terminal** | The pane opening by itself | 144 columns or more for the first automatic open; 110 once you have opened the board by hand. `/board` opens it at any width. |
| **HCF plan files** | The Plan section | Plans laid out the way the [HCF](https://github.com/markshust/hcf) plugin writes them. Tested against HCF 1.1.1. Details in [Plan progress](#plan-progress-hcf). |
| **Playwright Test + Node.js** | The Playwright section | `@playwright/test` with the `PW_TEST_REPORTER` environment hook. Verified on 1.46, 1.54 and 1.58. Wired automatically for test runs the session starts; see [Playwright progress](#playwright-progress). |
| **A git repository** | The Playwright section | The reporter writes its progress file inside the repository's git directory. |

Neither HCF nor Playwright is required for the mod to load. A section with nothing to show is simply left out, and the Agents section works with any subagent.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pb-board --marketplace ProxiBlue/pb-board
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it load in every session). The mod is active as soon as the install finishes.

From a shell:

```
claude plugin install pb-board --marketplace ProxiBlue/pb-board
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ProxiBlue/pb-board`, then **Add plugin**.

### Run it from a clone instead

Useful if you want to change it:

```bash
git clone https://github.com/ProxiBlue/pb-board.git ~/pb-board
claude --plugin-dir ~/pb-board
```

To load the clone in every session without the flag, name it in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/pb-board"
  }
}
```

A folder loaded this way is watched: saving a file reloads the mod.

### Hide the built-in diff panel (optional)

The fullscreen UI's own right-hand pane is the diff panel. If you would rather see only the board, run `/diff` once to hide it; Claude Code remembers the choice. With both open, they share the dock as tabs.

## Use

| Command | Does |
| --- | --- |
| `/board` | Opens the board, or closes it if it is showing. |
| `/board <plan-name>` | Pins the plan at `.claude/plans/<plan-name>/` and opens the board. A path works too. |
| `/board off` | Closes the board. |

Most of the time you do not need the command:

- **The board follows the plan Claude is working on.** When any tool call — Claude's or a subagent's — reads or edits a file under `.claude/plans/<name>/`, that plan becomes the one shown, provided its status is `in_progress` (or `ready`, when no other plan is in progress).
- **The board opens by itself** once for each plan that goes `in_progress` and once for each Playwright run that starts.
- **Closing it sticks.** If you close the board (`ctrl+x x`, or `/board off`), it stays closed until a *different* plan or a *new* test run starts.

When the pane has the keyboard (`ctrl+x tab`), the arrow keys scroll it; `Esc` hands the keyboard back.

### Reading the board

| Mark | Meaning |
| --- | --- |
| `✓` | Task completed |
| `▶` | Task in progress, agent running, or test running |
| `·` | Task pending |
| `✗` | Task blocked, or test failed |
| `3/7` | Requirements ticked / total for that task |
| `r2` | The task's retry count |
| `✓5 ✗1 ~0 -0` | Tests passed, failed, flaky (passed on retry), skipped |
| `w0`, `w1` | The Playwright worker slot a test is running in |

## Plan progress (HCF)

The Plan section needs no setup and no change to HCF. It reads the files `hcf:plan-create` writes and `hcf:plan-orchestrate` updates:

```
.claude/plans/<plan-name>/
├── _plan.md            plan overview
├── 001-first-task.md   one file per task
├── 002-second-task.md
└── …
```

What it reads from **`_plan.md`**:

- the title, from the first heading (`# Plan: <title>`)
- the plan status, from the first line under `## Status` (`planning`, `ready`, `in_progress`, `completed`, `blocked`)
- the task table under a `## Task…` heading, as a fallback for tasks with no file:

  ```markdown
  ## Task Overview
  | Task | Description | Depends On | Status |
  |------|-------------|------------|--------|
  | 001 | Add users table migration | - | completed |
  ```

What it reads from each **task file** (named `<number>-<anything>.md`):

```markdown
# Task 001: Add users table migration

**Status**: in_progress
**Depends on**: -
**Retry count**: 0

## Requirements (Test Descriptions)
- [x] `it creates the users table`
- [ ] `it rejects a duplicate email`
```

- `**Status**:` gives the task's state. The task file wins over the table in `_plan.md`.
- `**Retry count**:` gives the `r2` marker.
- Checkboxes under the `## Requirements…` heading, up to the next `##` heading, give the `1/2` count.

Any tool that writes plans in this layout works; HCF is just the one it was built for. Other files in the folder (names starting with `_`, `.jsonl` files) are ignored.

## Playwright progress

Claude Code does not stream a running command's output to mods, so the board cannot read Playwright's terminal output. Instead the mod ships a small Playwright reporter, [`reporter/pb-board-reporter.cjs`](reporter/pb-board-reporter.cjs), that writes one JSON line per test event to a file the board reads.

### It wires itself

There is nothing to set up. When a session starts, the mod sets the environment variable `PW_TEST_REPORTER` to the absolute path of its own bundled reporter, for that Claude Code process. Every command the session then runs inherits it, so any `playwright test` Claude starts loads the reporter.

- Playwright loads it **in addition to** the reporters in your `playwright.config`. None of yours are replaced and your config file is not touched.
- The path is worked out from wherever the mod is installed, each time a session starts, so it stays right across upgrades and install methods (marketplace install, a clone, `--plugin-dir`).
- **If `PW_TEST_REPORTER` is already set to something else, the mod leaves it alone** and the Playwright section stays empty. Editor integrations use this variable too.
- **To switch the wiring off**, start Claude Code with `PB_BOARD_REPORTER=off` in the environment.

> `PW_TEST_REPORTER` is the hook Playwright's own editor integration uses to add a reporter. It is present in the versions listed under [Requirements](#requirements) but is not a documented public option, so a future Playwright release could change it. Listing the reporter in `playwright.config` (below) does not depend on it.

### When you have to wire it by hand

The automatic wiring only reaches processes the Claude Code session starts *directly*. Set it up by hand when Playwright runs somewhere that environment does not reach:

- **Inside a container while Claude Code runs outside it.** `docker exec`, `ddev exec` and friends do not pass the caller's environment through.
- **In your own terminal**, outside Claude Code, when you want a session to show the run.

In those cases give Playwright the reporter yourself. The reporter is a single file with no dependencies, so copy it anywhere, or use it from a clone of this repository:

```bash
# per command
PW_TEST_REPORTER=/abs/path/pb-board-reporter.cjs npx playwright test
```

```ts
// or in playwright.config.ts, like any other reporter
reporter: [['list'], ['/abs/path/pb-board-reporter.cjs']],
```

For a container, the path must exist **inside** the container (mount or copy the file in), and the variable must be set in the container's environment. The project's `.git` directory must be on a shared mount — it is whenever the project folder is bind-mounted — so the board can read the file from the other side.

If Claude Code itself runs inside the container, none of this applies: the automatic wiring works there as anywhere.

### Where the progress file goes

`<git dir>/pb-board/playwright.jsonl`, where the git directory is found by walking up from the Playwright config's folder. It lives *inside* `.git`, so it never shows up in `git status` and cannot be committed. Each run overwrites the last.

The board looks for that file in the git directory of:

- the folder the session started in,
- the project of the plan it is following, and
- any folder a `cd …` in a `playwright test` command points at.

Set `PB_BOARD_FILE` in Playwright's environment to make the reporter write somewhere else — only useful to point it at one of those locations when your Playwright config sits outside the repository.

### The reporter's promises

- It never fails a run: every write is wrapped, and on any error it goes quiet.
- It prints nothing to the terminal.
- It writes one file and reads none besides `.git` (to find the git directory).

## How it works

```
 tool calls ──▶ tool.call hook ──▶ notes plan paths / playwright commands (no I/O)
                                            │
 1 s timer ──▶ reads _plan.md + task files  ┤
               lists running agents         ├──▶ board state ──▶ pane redraws
               reads playwright.jsonl       ┘
```

- **Observer only.** The `tool.call` hook looks at the call's file path or command, remembers what it saw, and passes the call on untouched. It makes no engine calls, so it adds no latency and cannot refuse or alter anything.
- **One environment variable.** At session start the mod sets `PW_TEST_REPORTER` for the session's process, unless it is already set or `PB_BOARD_REPORTER=off`. That is the only thing it changes outside its own state.
- **A one-second timer** does the reading. Files are re-read only when their modification time changes. While nothing is active the timer drops to one pass every five seconds.
- **The pane redraws only when the data changes.** Elapsed-time counters tick only while an agent or a test is actually running.
- **State is per session.** Nothing is written to disk by the mod itself; a new session starts with an empty board.

| File | Role |
| --- | --- |
| `hooks/register.tsx` | The mod: hooks, the poll loop, the `/board` command, the pane |
| `hooks/parse.ts` | Pure parsers for plan files, task files and the reporter's lines |
| `types/index.d.ts` | The mod's state contract |
| `reporter/pb-board-reporter.cjs` | The Playwright reporter (runs in Node, not in Claude Code) |
| `tests/board.test.tsx` | Tests, run by `claude plugin test` |

## Limits

- **Early-access API.** Mods are new and their API moves. A Claude Code update may need a matching update here.
- **Interactive sessions only.** Under `claude -p` nothing is drawn; the hooks still load and stay out of the way.
- **Polling, not events.** The mods API has no file watcher. Changes show within about a second.
- **One plan at a time.** The board shows the most recently touched active plan.
- **One Playwright run at a time per repository.** Each run overwrites the progress file. Two suites running at once in the same repository will interleave.
- **A killed run looks alive for a while.** If Playwright is killed before it can write its last line, the board shows the run as `running` until ten minutes pass with no new event, then marks it `stalled`.
- **Runs from before the session are ignored.** A finished run only shows if it ended after the session began.
- **Terminal output is not read.** A run that does not load the reporter (see [When you have to wire it by hand](#when-you-have-to-wire-it-by-hand)) leaves the Playwright section empty.
- **Not type-checked in CI.** The mod is checked by `claude plugin validate` and `claude plugin test`; there is no `tsc` step yet.

## Troubleshooting

**The pane never appears.**
Run `/board`. If that works, the terminal is narrower than the automatic-open threshold (144 columns, or 110 once you have opened it by hand). If `/board` is not a known command, the mod is not loaded: check `claude plugin list`, then `/reload-plugins`.

**The pane is there but behind another tab.**
The diff panel is open too. Click the Board tab, or hide the diff panel with `/diff`.

**The Plan section is empty.**
The board follows a plan only after a tool call has touched it in this session and only while its status is `in_progress` or `ready`. Pin one with `/board <plan-name>`. If the plan shows but tasks are missing, check the task files are named `<number>-<name>.md` and carry a `**Status**:` line.

**The Playwright section is empty.**
Check, in order:
1. Ask Claude to run `printenv PW_TEST_REPORTER`. It should print a path ending in `reporter/pb-board-reporter.cjs`. If it prints something else, another tool owns the variable; if Playwright runs in a container or another terminal, the session's environment does not reach it — wire it by hand.
2. After a run, `<repo>/.git/pb-board/playwright.jsonl` exists and has a fresh timestamp. If it does not, the reporter did not load — Playwright prints an error when the path is wrong.
3. The session was started inside that repository, or the test command contains a `cd` into it.

**Something is wrong and nothing says why.**
Start Claude Code with `claude --debug`. A hook that fails is skipped, and the debug log names it and the reason, prefixed `pb-board:`.

## Development

```bash
git clone https://github.com/ProxiBlue/pb-board.git
cd pb-board

claude plugin validate .   # manifest + hooks module, as the engine reads them
claude plugin test .       # runs tests/*.test.tsx against the engine

claude --plugin-dir .      # run a session with the mod loaded from this folder
```

When Claude Code loads the mod from a folder like this, it writes the API's type declarations into `.claude-plugin/types/` (git-ignored) and the top-level `tsconfig.json` extends them, so an editor or `tsc -p .` can type-check the mod.

One rule of the engine worth knowing before you edit: the engine interface `$` may only be passed to functions declared at the top level of a hooks file (or imported from another file of the mod). A helper that takes `$` cannot be a closure inside `register`; `claude plugin validate` refuses it.

To try the Playwright section without a real suite, any spec with a few `await new Promise(r => setTimeout(r, 2000))` tests and no browser fixtures will do.

## Attributions & licensing

pb-board is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright © 2026 Lucas van Staden / Proxiblue — <https://www.proxiblue.com.au>

You are free to use, modify and redistribute it, commercially or otherwise. In return the licence requires that you:

- keep the `LICENSE` and `NOTICE` files, and the copyright and attribution notices, in any copy or derivative work you distribute;
- state clearly in any file you changed that you changed it;
- do not present a modified version as the original.

pb-board bundles no third-party code. It works alongside, and is not affiliated with or endorsed by:

- [Claude Code](https://claude.com/claude-code) by Anthropic
- [HCF](https://github.com/markshust/hcf) by Mark Shust (MIT)
- [Playwright](https://github.com/microsoft/playwright) by Microsoft (Apache-2.0)
