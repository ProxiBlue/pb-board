import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  cdTargets,
  foldProgress,
  isPlaywrightRun,
  parsePlan,
  parseTask,
  planDirIn,
} from '../hooks/parse'

const PLAN_MD = `# Plan: Demo feature

## Created
2026-11-11

## Status
in_progress

## Success Criteria
| 1 | not a task | - | pending |

## Task Overview
| Task | Description | Depends On | Status |
|------|-------------|------------|--------|
| 001 | First \`thing\` | - | completed |
| 002 | Second thing | 001 | in_progress |
| 003 | Third thing | 001, 002 | pending |

## Architecture Notes
- none
`

const task = (id: string, title: string, status: string, boxes: string) =>
  `# Task ${id}: ${title}

**Status**: ${status}
**Depends on**: -
**Retry count**: ${id === '002' ? 1 : 0}

## Description
Whatever.

## Requirements (Test Descriptions)
${boxes}

## Notes
- [ ] not a requirement
`

const PANE = {
  plugin: 'pb-board',
  component: 'Pane',
  requestId: 'pb-board',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type World = {
  files: Map<string, string>
  touch: (path: string, text: string) => void
  opened: string[]
  env: Map<string, string>
}

let stamp = 1

/** Stands for the engine beneath the mod: a file tree in memory. */
function world(
  on: On,
  seed: Record<string, string>,
  variables: Record<string, string> = {},
): World {
  const env = new Map<string, string>(Object.entries(variables))
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const opened: string[] = []
  const touch = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, stamp++)
  }
  const isDir = (path: string) =>
    [...files.keys()].some(file => file.startsWith(`${path}/`))

  for (const [path, text] of Object.entries(seed)) {
    touch(path, text)
  }

  on('fs.list', (_, e) => {
    const names = new Set<string>()

    for (const file of files.keys()) {
      if (file.startsWith(`${e.path}/`)) {
        names.add(file.slice(e.path.length + 1).split('/')[0] ?? '')
      }
    }

    return names.size === 0
      ? { deny: 'ENOENT' }
      : {
          value: [...names].map(name => ({
            name,
            kind: files.has(`${e.path}/${name}`) ? 'file' : 'dir',
            size: 1,
            mtimeMs: mtimes.get(`${e.path}/${name}`) ?? 0,
            isLink: false,
          })),
        }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  // The mod's bundled reporter is there wherever the engine put the mod.
  on('fs.exists', (_, e) => ({
    value:
      files.has(e.path) ||
      isDir(e.path) ||
      e.path.endsWith('/reporter/pb-board-reporter.cjs'),
  }))
  on('fs.stat', (_, e) => ({
    value: {
      kind: files.has(e.path) ? 'file' : 'dir',
      size: 1,
      mtimeMs: mtimes.get(e.path) ?? 0,
      isLink: false,
    },
  }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => {
    if (e.value === undefined) {
      env.delete(e.name)
    } else {
      env.set(e.name, e.value)
    }

    return { value: {} }
  })
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0 } }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  return { files, touch, opened, env }
}

test('the parsers read a plan, a task and a command', () => {
  const plan = parsePlan(PLAN_MD)

  expect(plan.title).toBe('Demo feature')
  expect(plan.status).toBe('in_progress')
  expect(plan.rows.map(row => row.id)).toEqual(['001', '002', '003'])
  expect(plan.rows[0]?.title).toBe('First thing')
  expect(plan.rows[2]?.deps).toBe('001, 002')

  const read = parseTask(
    task('002', 'Second thing', 'in_progress', '- [x] `it a`\n- [ ] `it b`'),
  )

  expect(read).toEqual({
    title: 'Second thing',
    status: 'in_progress',
    deps: '',
    done: 1,
    total: 2,
    retries: 1,
  })

  expect(planDirIn('/repo/.claude/plans/demo/001-a.md', '/x')).toBe(
    '/repo/.claude/plans/demo',
  )
  expect(planDirIn('cat .claude/plans/demo/_plan.md | head', '/repo')).toBe(
    '/repo/.claude/plans/demo',
  )
  expect(planDirIn('ls .claude/plans/', '/repo')).toBe(null)
  expect(planDirIn('ls src', '/repo')).toBe(null)
  expect(isPlaywrightRun('cd tests && npx playwright test --grep @smoke')).toBe(
    true,
  )
  expect(isPlaywrightRun('npx playwright install; npm test')).toBe(false)
  expect(cdTargets('cd tests/e2e && npx playwright test', '/repo')).toEqual([
    '/repo/tests/e2e',
  ])
})

test('the reporter lines fold into a run: retries, flaky, failures', () => {
  const lines = [
    { t: 'begin', total: 4, workers: 2, ts: 1000 },
    { t: 'start', id: 'a', title: 'a.spec.ts › passes', worker: 0, retry: 0, ts: 1100 },
    { t: 'start', id: 'b', title: 'b.spec.ts › flakes', worker: 1, retry: 0, ts: 1100 },
    { t: 'end', id: 'a', status: 'passed', outcome: 'expected', final: true, duration: 400, ts: 1500 },
    { t: 'end', id: 'b', status: 'failed', outcome: 'unexpected', final: false, duration: 500, ts: 1600 },
    { t: 'start', id: 'b', title: 'b.spec.ts › flakes', worker: 1, retry: 1, ts: 1700 },
    { t: 'start', id: 'c', title: 'c.spec.ts › fails', worker: 0, retry: 0, ts: 1700 },
    { t: 'end', id: 'b', status: 'passed', outcome: 'flaky', final: true, duration: 300, ts: 2000 },
    { t: 'end', id: 'c', status: 'failed', outcome: 'unexpected', final: true, duration: 900, ts: 2600 },
    { t: 'start', id: 'd', title: 'd.spec.ts › runs', worker: 1, retry: 0, ts: 2700 },
  ]
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\nnot json\n'
  const run = foldProgress(text)

  expect(run?.total).toBe(4)
  expect(run?.passed).toBe(1)
  expect(run?.flaky).toBe(1)
  expect(run?.failed).toBe(1)
  expect(run?.failures.map(one => one.title)).toEqual(['c.spec.ts › fails'])
  expect(run?.running.map(one => one.id)).toEqual(['d'])
  expect(run?.endedAt).toBe(null)

  const ended = foldProgress(
    text + JSON.stringify({ t: 'done', status: 'failed', ts: 3000 }) + '\n',
  )

  expect(ended?.endedAt).toBe(3000)
  expect(ended?.status).toBe('failed')
  expect(ended?.running).toEqual([])
  expect(foldProgress('')).toBe(null)
})

test('a plan a tool call touches is followed, drawn and redrawn', async ($, on) => {
  const dir = '/repo/.claude/plans/demo'
  const clock = mock.clock(on, { now: 1_000_000 })
  const { touch, opened } = world(on, {
    [`${dir}/_plan.md`]: PLAN_MD,
    [`${dir}/_timing.jsonl`]: '{}',
    [`${dir}/001-first.md`]: task('001', 'First thing', 'completed', '- [x] a\n- [x] b'),
    [`${dir}/002-second.md`]: task('002', 'Second thing', 'in_progress', '- [x] a\n- [ ] b'),
    [`${dir}/003-third.md`]: task('003', 'Third thing', 'pending', '- [ ] a'),
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  expect(opened).toEqual([])

  await $.tool.call({ tool: 'Read', file_path: `${dir}/_plan.md` })
  await clock.advance(1000)

  // An in-progress plan opens the pane once, unasked.
  expect(opened).toEqual(['pb-board'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^PLAN/ }))?.text).toBe('PLAN demo')
    expect((await ui.find({ type: 'Text', text: /tasks/ }))?.text).toBe(
      '1/3 tasks · 3/5 reqs',
    )
    expect((await ui.find({ type: 'Text', text: /002 Second/ }))?.text).toMatch(
      /^002 Second thing\s*$/,
    )
    expect(await ui.find({ type: 'Text', text: /1\/2 r1/ })).toBeDefined()
    await ui.unmount()
  }

  touch(
    `${dir}/002-second.md`,
    task('002', 'Second thing', 'completed', '- [x] a\n- [x] b'),
  )
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /tasks/ }))?.text).toBe(
    '2/3 tasks · 4/5 reqs',
  )
  await ui.unmount()

  // Closed by hand or not, the same plan never opens the pane twice.
  await clock.advance(5000)
  expect(opened).toEqual(['pb-board'])
})

test('a Playwright run in the repository is drawn as it goes', async ($, on) => {
  const feed = '/shop/.git/pb-board/playwright.jsonl'
  const clock = mock.clock(on, { now: 2_000_000 })
  const line = (one: object) => JSON.stringify(one) + '\n'
  const begun =
    line({ t: 'begin', total: 3, workers: 2, ts: 1_999_000 }) +
    line({ t: 'start', id: 'a', title: 'cart.spec.ts › adds', worker: 0, retry: 0, ts: 1_999_500 })
  const { touch, opened } = world(on, {
    '/shop/.git/HEAD': 'ref: refs/heads/main',
    [feed]: begun,
  })

  await $.session.start({ cwd: '/shop/app', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  expect(opened).toEqual(['pb-board'])

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^PLAYWRIGHT/ }))?.text).toBe('PLAYWRIGHT')
  expect(await ui.find({ type: 'Text', text: /w0 cart\.spec\.ts › adds/ })).toBeDefined()
  await ui.unmount()

  touch(
    feed,
    begun +
      line({ t: 'end', id: 'a', status: 'failed', outcome: 'unexpected', final: true, duration: 700, ts: 2_001_200 }) +
      line({ t: 'done', status: 'failed', ts: 2_001_300 }),
  )
  await clock.advance(1000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^✗1/ }))?.text).toBe('✗1 ')
  expect(await ui.find({ type: 'Text', text: /^cart\.spec\.ts › adds/ })).toBeDefined()
  await ui.unmount()
})

test('with nothing to follow the pane says so, and no tool call is refused', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })

  world(on, { '/empty/readme.md': 'x' })
  await $.session.start({ cwd: '/empty', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npx playwright test' })

  expect(ran.deny).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /No active/ }))?.text).toBe(
    'No active plan, agents or test run.',
  )
  await ui.unmount()
})

test('the session start points Playwright at the bundled reporter', async ($, on) => {
  // The mod's own folder is the engine's to say: the reporter is told by its tail.
  const TAIL = '/reporter/pb-board-reporter.cjs'
  const start = { cwd: '/app', surface: 'terminal', isInteractive: true } as const

  mock.clock(on, { now: 4_000_000 })
  const { env } = world(on, { '/app/readme.md': 'x' })

  // Unset: wired to this install's reporter.
  await $.session.start(start)

  const wired = env.get('PW_TEST_REPORTER') ?? ''

  expect(wired.endsWith(TAIL)).toBe(true)
  expect(wired.startsWith('/')).toBe(true)

  // Ours from an older install path: replaced.
  env.set('PW_TEST_REPORTER', `/old/0.1.0${TAIL}`)
  await $.session.start(start)
  expect(env.get('PW_TEST_REPORTER')).toBe(wired)

  // Someone else's reporter: left alone.
  env.set('PW_TEST_REPORTER', '/their/reporter.js')
  await $.session.start(start)
  expect(env.get('PW_TEST_REPORTER')).toBe('/their/reporter.js')

  // Switched off: left unset.
  env.delete('PW_TEST_REPORTER')
  env.set('PB_BOARD_REPORTER', 'off')
  await $.session.start(start)
  expect(env.get('PW_TEST_REPORTER')).toBeUndefined()
})
