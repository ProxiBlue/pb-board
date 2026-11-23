# PB Board for Codex CLI

A live companion terminal pane for HCF tasks, Codex subagents, and Playwright
workers. Run it beside Codex in a terminal split (such as tmux) or a separate
terminal. The board refreshes while you work.

## Install

Use Codex CLI with lifecycle hooks, Git, and Node.js 22.18 or later.

```sh
git clone --branch codex https://github.com/ProxiBlue/pb-board.git
cd pb-board
codex plugin marketplace add "$PWD"
codex plugin add pb-board-codex@pb-board
```

Start Codex in the project you want to monitor. Use `/hooks` to review and trust
the PB Board hooks, then start or resume the session again if needed. The
[Codex hook guide](https://learn.chatgpt.com/docs/hooks) describes hook trust.

## Open the board

In a second terminal pane, from the project or with its path:

```sh
node /path/to/pb-board/codex/board.mjs --cwd /path/to/project
```

- **Plan** follows the first in-progress HCF plan, then a ready plan, then the
  most recently changed overview. Use `--plan my-plan` to pin a folder under
  `.claude/plans/`.
- **Agents** shows active agents from the latest active Codex session in this
  worktree. Use `--session ID` to pin a session when several are open.
- **Playwright** reads pb-board's existing reporter. Launch Codex with the
  reporter environment variable, or prefix an individual Playwright run with it.

```sh
PW_TEST_REPORTER=/path/to/pb-board/reporter/pb-board-reporter.cjs codex
```

Use a reporter path visible to Playwright when it runs in a container. For
parallel test runs in one worktree, set `PB_BOARD_FILE` to a separate path for
each reporter and the board that follows it. `--once` prints one full snapshot
for logs or inspection.

Agent hooks store session IDs, agent IDs, agent types, and timestamps in
`<git-dir>/pb-board/codex/`. You can delete old JSONL files from that folder
after their sessions end. Each linked worktree has its own Git directory and
feed. A force-killed session may leave an active record. Selecting a session
explicitly avoids picking that stale record.

The Codex board is a terminal companion. Setting up the plugin only enables the
agent feed. The plan reader and the Playwright reporter can be used separately.
