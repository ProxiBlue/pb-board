export type TaskRow = {
  id: string
  title: string
  status: string
  deps: string
  done: number
  total: number
  retries: number
}

export type PlanView = {
  dir: string
  name: string
  title: string
  status: string
  tasks: TaskRow[]
}

export type AgentRow = {
  id: string
  type: string
  label: string
  status: string
  since: number
}

export type TestState =
  | 'running'
  | 'retry'
  | 'passed'
  | 'failed'
  | 'flaky'
  | 'skipped'

export type TestRow = {
  id: string
  title: string
  state: TestState
  worker: number
  retry: number
  startedAt: number
  durationMs: number
}

export type TestsView = {
  file: string
  total: number
  workers: number
  startedAt: number
  endedAt: number | null
  lastAt: number
  status: string | null
  passed: number
  failed: number
  flaky: number
  skipped: number
  running: TestRow[]
  failures: TestRow[]
}

export type Board = {
  plan: PlanView | null
  agents: AgentRow[]
  tests: TestsView | null
  now: number
}

export type Focus = {
  /** The plan the board follows, absolute. */
  planDir: string | null
  /** A plan a tool call touched, not yet judged. */
  candidate: string | null
  /** Git dirs a Playwright progress file may sit in. */
  feeds: string[]
  /** The plan the pane was last opened for, so a close by hand stands. */
  openedPlan: string
  /** The test run (its start time) the pane was last opened for. */
  openedRun: number
}

declare module 'claude-code' {
  interface PluginState {
    'pb-board': { board: Shaped<Board>; focus: Shaped<Focus> }
  }
}
