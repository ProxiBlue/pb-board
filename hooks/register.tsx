import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRow,
  Board,
  Focus,
  PlanView,
  TaskRow,
  TestsView,
} from '../types'
import {
  bar,
  cdTargets,
  clip,
  elapsed,
  foldProgress,
  isPlaywrightRun,
  parsePlan,
  parseTask,
  planDirIn,
  resolvePath,
} from './parse'

const PANE = 'pb-board'
const TITLE = 'Board'
const FEED = 'pb-board/playwright.jsonl'
const REPORTER = 'reporter/pb-board-reporter.cjs'
const TICK_MS = 1000
const SLOW_EVERY = 5
const STALL_MS = 10 * 60_000

const EMPTY: Board = { plan: null, agents: [], tests: null, now: 0 }
const NO_FOCUS: Focus = {
  planDir: null,
  candidate: null,
  feeds: [],
  openedPlan: '',
  openedRun: 0,
}

// Change a tag when its value's fields change: a reload then reads what the
// earlier code stored as the initial.
const board = atom({ plugin: 'pb-board', key: 'board' } as const, EMPTY, {
  shape: 'board-1',
})
const focus = atom({ plugin: 'pb-board', key: 'focus' } as const, NO_FOCUS, {
  shape: 'focus-2',
})

type Cached = { mtimeMs: number; text: string }

const isLiveAgent = (status: string): boolean =>
  status === 'running' || status === 'pending' || status === 'waiting'

// The module's own: gone at a reload, which `session.start` then refills.
let cwd = ''
let sessionStartedAt = 0
let isTicking = false
let isDirty = true
let beat = 0
let pendingCandidate: string | null = null
let pendingFeedDirs: string[] = []
const texts = new Map<string, Cached>()

const readCached = async (
  $: EngineInterface,
  path: string,
  mtimeMs: number,
): Promise<string> => {
  const was = texts.get(path)

  if (was !== undefined && was.mtimeMs === mtimeMs) {
    return was.text
  }

  const text = await $.fs.read(path)
  texts.set(path, { mtimeMs, text })

  return text
}

const loadPlan = async (
  $: EngineInterface,
  dir: string,
): Promise<PlanView | null> => {
  const entries = await $.fs.list(dir)
  const headFile = entries.find(entry => entry.name === '_plan.md')

  if (headFile === undefined) {
    return null
  }

  const head = parsePlan(
    await readCached($, `${dir}/_plan.md`, headFile.mtimeMs),
  )
  const tasks: TaskRow[] = []

  for (const entry of entries) {
    const id = /^(\d{1,4}[a-z]?)-.*\.md$/.exec(entry.name)?.[1]

    if (id === undefined || entry.kind !== 'file') {
      continue
    }

    const task = parseTask(
      await readCached($, `${dir}/${entry.name}`, entry.mtimeMs),
    )
    const row = head.rows.find(one => one.id === id)

    tasks.push({
      id,
      title: task.title || row?.title || entry.name,
      status: task.status || row?.status || 'pending',
      deps: task.deps || row?.deps || '',
      done: task.done,
      total: task.total,
      retries: task.retries,
    })
  }

  for (const row of head.rows) {
    if (!tasks.some(task => task.id === row.id)) {
      tasks.push({ ...row, done: 0, total: 0, retries: 0 })
    }
  }

  tasks.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))

  return {
    dir,
    name: dir.slice(dir.lastIndexOf('/') + 1),
    title: head.title,
    status: head.status,
    tasks,
  }
}

/** The git dir of the repository `start` lies in, walking up. */
const gitDirOf = async (
  $: EngineInterface,
  start: string,
): Promise<string | null> => {
  let dir = start

  for (let i = 0; i < 24; i++) {
    const dot = dir === '/' ? '/.git' : `${dir}/.git`

    try {
      if (await $.fs.exists(dot)) {
        const stat = await $.fs.stat(dot)

        if (stat.kind === 'dir') {
          return dot
        }

        // A worktree's `.git` is a file naming its git dir.
        const named = /^gitdir:\s*(.+)$/m.exec(await $.fs.read(dot))?.[1]

        if (named !== undefined) {
          return resolvePath(dir, named.trim())
        }
      }
    } catch {
      // Unreadable here: keep walking.
    }

    if (dir === '/' || dir === '') {
      break
    }

    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }

  return null
}

/** Adds the git dir of the repository `dir` lies in to the feeds, newest first. */
const addFeed = async (
  $: EngineInterface,
  feeds: string[],
  dir: string,
): Promise<void> => {
  const git = await gitDirOf($, dir)

  if (git !== null && !feeds.includes(git)) {
    feeds.unshift(git)
    feeds.splice(6)
  }
}

const loadTests = async (
  $: EngineInterface,
  feeds: readonly string[],
  now: number,
): Promise<TestsView | null> => {
  let newest: { file: string; mtimeMs: number } | null = null

  for (const feed of feeds) {
    const file = `${feed}/${FEED}`

    try {
      if (!(await $.fs.exists(file))) {
        continue
      }

      const { mtimeMs } = await $.fs.stat(file)

      if (newest === null || mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs }
      }
    } catch {
      // No feed there.
    }
  }

  if (newest === null) {
    return null
  }

  const run = foldProgress(
    await readCached($, newest.file, newest.mtimeMs),
  )

  if (run === null) {
    return null
  }

  // A run that was killed writes no last line: call it after a long quiet.
  if (run.endedAt === null && now - run.lastAt > STALL_MS) {
    run.endedAt = run.lastAt
    run.status = 'stalled'
    run.running = []
  }

  // A run that ended before this session began is another session's.
  if (run.endedAt !== null && run.endedAt < sessionStartedAt) {
    return null
  }

  return { ...run, file: newest.file }
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (isTicking) {
    return
  }

  isTicking = true

  try {
    const was = await read($, board)
    const isLive =
      was.agents.length > 0 ||
      (was.tests !== null && was.tests.endedAt === null) ||
      was.plan?.status === 'in_progress'

    beat += 1

    if (!isDirty && !isLive && beat % SLOW_EVERY !== 0) {
      return
    }

    isDirty = false

    const now = await $.clock.now()
    const at = await read($, focus)
    let planDir = at.planDir
    const feeds = [...at.feeds]
    for (const dir of pendingFeedDirs.splice(0)) {
      await addFeed($, feeds, dir)
    }

    let plan =
      planDir === null ? null : await loadPlan($, planDir).catch(() => null)
    const candidate = pendingCandidate ?? at.candidate
    pendingCandidate = null

    if (candidate !== null && candidate !== planDir) {
      const seen = await loadPlan($, candidate).catch(() => null)
      const isTaken =
        seen !== null &&
        (seen.status === 'in_progress' ||
          (seen.status === 'ready' && plan?.status !== 'in_progress'))

      if (isTaken) {
        plan = seen
        planDir = candidate
        // <project>/.claude/plans/<name>: the project is three up.
        await addFeed($, feeds, resolvePath(candidate, '../../..'))
      }
    }

    const listed = await $.agent.list().catch(() => [])
    const agents: AgentRow[] = listed
      .filter(agent => isLiveAgent(agent.status))
      .map(agent => ({
        id: agent.id,
        type: agent.type,
        label: agent.name ?? agent.description,
        status: agent.status,
        since: was.agents.find(one => one.id === agent.id)?.since ?? now,
      }))
    const tests = await loadTests($, feeds, now).catch(() => null)
    const isRunning = tests !== null && tests.endedAt === null
    const next: Board = {
      plan,
      agents,
      tests,
      // The clock moves the drawing only while something counts time.
      now: agents.length > 0 || isRunning ? now : was.now,
    }

    if (JSON.stringify(next) !== JSON.stringify(was)) {
      await update($, board, () => next)
    }

    const isPlanActive = plan !== null && plan.status === 'in_progress'
    const opensForPlan = isPlanActive && plan?.dir !== at.openedPlan
    const opensForRun = isRunning && tests?.startedAt !== at.openedRun
    const after: Focus = {
      planDir,
      candidate: null,
      feeds,
      openedPlan: opensForPlan ? (plan?.dir ?? '') : at.openedPlan,
      openedRun: opensForRun ? (tests?.startedAt ?? 0) : at.openedRun,
    }

    if (JSON.stringify(after) !== JSON.stringify(at)) {
      await update($, focus, () => after)
    }

    // Opened once per plan and per run: closed by hand, it stays closed
    // until another plan or run starts.
    if (opensForPlan || opensForRun) {
      await $.ui.open({ id: PANE, title: TITLE, columns: 48 })
    }
  } catch (error) {
    $.ui.log(`pb-board: ${String(error).slice(0, 200)}`)
  } finally {
    isTicking = false
  }
}

/**
 * Points Playwright's extra-reporter hook at the reporter this mod ships, for
 * every test run the session starts: no settings to edit, and the path is
 * right wherever the mod is installed. Something else's reporter is left
 * alone, as is a session that set PB_BOARD_REPORTER=off.
 */
const wireReporter = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await $.env.get('PB_BOARD_REPORTER')) === 'off') {
      return
    }

    const reporter = `${$.plugin.root}/${REPORTER}`
    const current = (await $.env.get('PW_TEST_REPORTER')) ?? ''
    // Ours from an earlier install path (a version's cache folder) is replaced.
    const isOurs = current.endsWith(`/${REPORTER}`)

    if (current === reporter || (current !== '' && !isOurs)) {
      return
    }

    if (await $.fs.exists(reporter)) {
      await $.env.set('PW_TEST_REPORTER', reporter)
    }
  } catch (error) {
    $.ui.log(`pb-board: reporter not wired: ${String(error).slice(0, 200)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'board',
      description:
        'Toggle the board pane: HCF plan tasks, running agents, Playwright tests',
      argumentHint: '[plan-name | off]',
    })
    sessionStartedAt = await $.session
      .usage()
      .then(usage => usage.startedAt)
      .catch(() => $.clock.now())
    pendingFeedDirs.push(cwd)
    isDirty = true
    await wireReporter($)
    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return next(e)
  })

  // Reads the call and nothing else: no `$` here, so a call is never slowed
  // or refused by the board. The timer picks up what was seen.
  on('tool.call', ($, e, next) => {
    try {
      const seen = e as unknown as Record<string, unknown>
      const tool = String(seen['tool'])
      const path = seen['file_path']
      const command = seen['command']

      if (typeof path === 'string') {
        const dir = planDirIn(path, cwd)

        if (dir !== null) {
          pendingCandidate = dir
          isDirty = true
        }
      }

      if (typeof command === 'string') {
        const dir = planDirIn(command, cwd)

        if (dir !== null) {
          pendingCandidate = dir
          isDirty = true
        }

        if (isPlaywrightRun(command)) {
          pendingFeedDirs.push(...cdTargets(command, cwd))
          isDirty = true
        }
      }

      if (tool === 'Agent' || tool === 'Task') {
        isDirty = true
      }
    } catch {
      // Never the call's problem.
    }

    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const arg = (e.args ?? '').trim()

    if (arg === 'off' || arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Board closed.' }
    }

    if (arg !== '') {
      const dir = resolvePath(
        cwd,
        arg.includes('/') ? arg : `.claude/plans/${arg}`,
      )
      const plan = await loadPlan($, dir).catch(() => null)

      if (plan === null) {
        return { text: `No plan at ${dir} (no _plan.md there).` }
      }

      await update($, focus, at => ({
        ...at,
        planDir: dir,
        candidate: null,
        openedPlan: dir,
      }))
      pendingFeedDirs.push(resolvePath(dir, '../../..'))
      isDirty = true
      await $.ui.open({ id: PANE, title: TITLE, columns: 48 })

      return { text: `Board follows plan ${plan.name}.` }
    }

    const isShown = (await $.ui.panes()).some(
      pane => pane.id === PANE && pane.isPlaced,
    )

    if (isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'Board closed.' }
    }

    isDirty = true
    await $.ui.open({ id: PANE, title: TITLE, columns: 48 })

    return { text: 'Board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, board)
    const width = Math.max(24, e.props.bodyColumns)
    const { plan, agents, tests, now } = view

    /** One row: a glyph, a text cut to fit, and a dim note at the right. */
    const row = (
      glyph: string,
      color: string | undefined,
      text: string,
      note: string,
      isDim = false,
    ) => {
      const room = width - 2 - (note === '' ? 0 : note.length + 1)

      return (
        <Box>
          <Text color={color} dimColor={color === undefined}>
            {glyph}{' '}
          </Text>
          <Text dimColor={isDim}>{clip(text, room).padEnd(room)}</Text>
          {note !== '' && <Text dimColor> {note}</Text>}
        </Box>
      )
    }

    const head = (label: string, note: string, color?: string) => (
      <Box>
        <Text bold>{clip(label, width - note.length - 1)}</Text>
        {note !== '' && <Text color={color} dimColor={color === undefined}> {note}</Text>}
      </Box>
    )

    const taskRow = (task: TaskRow) => {
      const count = task.total > 0 ? `${task.done}/${task.total}` : ''
      const retry = task.retries > 0 ? ` r${task.retries}` : ''
      const text = `${task.id} ${task.title}`

      if (task.status === 'completed') {
        return row('✓', 'success', text, count, true)
      }

      if (task.status === 'in_progress') {
        return row('▶', 'warning', text, count + retry)
      }

      if (task.status === 'blocked') {
        return row('✗', 'error', text, `blocked${retry}`)
      }

      return row('·', undefined, text, count + retry, true)
    }

    const planPart = (one: PlanView) => {
      const tasksDone = one.tasks.filter(t => t.status === 'completed').length
      const reqs = one.tasks.reduce((sum, t) => sum + t.total, 0)
      const reqsDone = one.tasks.reduce((sum, t) => sum + t.done, 0)
      const color =
        one.status === 'completed'
          ? 'success'
          : one.status === 'blocked'
            ? 'error'
            : one.status === 'in_progress'
              ? 'warning'
              : undefined

      return (
        <Box flexDirection="column">
          {head(`PLAN ${one.name}`, one.status || '?', color)}
          <Text dimColor>
            {clip(
              `${tasksDone}/${one.tasks.length} tasks` +
                (reqs > 0 ? ` · ${reqsDone}/${reqs} reqs` : ''),
              width,
            )}
          </Text>
          <Text color={color}>
            {reqs > 0
              ? bar(reqsDone, reqs, width)
              : bar(tasksDone, one.tasks.length, width)}
          </Text>
          {one.tasks.map(taskRow)}
        </Box>
      )
    }

    const agentsPart = (list: AgentRow[]) => (
      <Box flexDirection="column" marginTop={1}>
        {head('AGENTS', String(list.length))}
        {list.map(agent =>
          row(
            agent.status === 'running' ? '▶' : '·',
            agent.status === 'running' ? 'warning' : undefined,
            `${agent.type.replace(/^.*:/, '')} ${agent.label}`,
            elapsed(now - agent.since),
          ),
        )}
      </Box>
    )

    const testsPart = (run: TestsView) => {
      const done = run.passed + run.failed + run.flaky + run.skipped
      const isRunning = run.endedAt === null
      const color = isRunning
        ? 'warning'
        : run.failed > 0 || (run.status !== 'passed' && run.status !== null)
          ? 'error'
          : 'success'
      const state = isRunning ? 'running' : (run.status ?? 'done')
      const took = elapsed((run.endedAt ?? now) - run.startedAt)

      return (
        <Box flexDirection="column" marginTop={1}>
          {head('PLAYWRIGHT', `${state} ${took}`, color)}
          <Box>
            <Text>
              {done}/{run.total}{'  '}
            </Text>
            <Text color="success">✓{run.passed} </Text>
            <Text color={run.failed > 0 ? 'error' : undefined} dimColor={run.failed === 0}>
              ✗{run.failed}{' '}
            </Text>
            <Text color={run.flaky > 0 ? 'warning' : undefined} dimColor={run.flaky === 0}>
              ~{run.flaky}{' '}
            </Text>
            <Text dimColor>-{run.skipped}</Text>
          </Box>
          <Text color={color}>{bar(done, run.total, width)}</Text>
          {run.running.map(test =>
            row(
              '▶',
              'warning',
              `w${test.worker} ${test.title}` +
                (test.retry > 0 ? ` (retry ${test.retry})` : ''),
              elapsed(now - test.startedAt),
            ),
          )}
          {run.failures
            .slice(-20)
            .map(test => row('✗', 'error', test.title, elapsed(test.durationMs)))}
        </Box>
      )
    }

    const isEmpty = plan === null && tests === null && agents.length === 0

    return (
      <Box flexDirection="column">
        {plan !== null && planPart(plan)}
        {agents.length > 0 && agentsPart(agents)}
        {tests !== null && testsPart(tests)}
        {isEmpty && (
          <Box flexDirection="column">
            <Text dimColor>No active plan, agents or test run.</Text>
            <Text dimColor>/board &lt;plan-name&gt; pins a plan.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
