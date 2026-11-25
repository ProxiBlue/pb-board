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
import {
  bandLines,
  dur,
  exitWarning,
  groupFleet,
  ownRunsFrom,
  parseFleet,
  runnerKind,
} from '../hooks/watch'

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

/** What a stubbed `$.process.run` answers: a result, or null for a missing command. */
type Run = (argv: readonly string[]) => { exitCode: number; stdout: string } | null

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
  run: Run = () => null,
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
  on('session.usage', () => ({ value: { startedAt: 0 } as never }))
  on('process.run', (_, e) => {
    const ran = run(e.argv)

    return ran === null
      ? { deny: 'ENOENT' }
      : {
          value: {
            ...ran,
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        }
  })
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

// The real shape of a parallel suite run under an in-container Claude session
// (host ps): the Bash tool's wrapper, yarn, the parallel orchestrator, the
// lane's playwright, its workers and browsers; plus the session's own
// playwright-mcp and a slot agent's run that belongs to no session.
const PS = [
  '      1       0  111460 /sbin/docker-init -- /start.sh',
  '2741657       1  109996 /usr/bin/python3 /usr/bin/supervisord -n -c /etc/supervisor/supervisord-nginx-fpm.conf',
  '2487186       1  111299 /bin/bash /mnt/ddev_config/commands/web/claude',
  '2487194 2487186  111299 claude --mcp-config /home/dev/.claude/mcp.json',
  "1624246 2487194    3269 /bin/bash -c source /home/dev/.claude/shell-snapshots/snapshot-bash-1795509285988-act727.sh 2>/dev/null || true && eval 'cd /var/www/html/tests/apps/shop && set -o pipefail && yarn --silent test:all --slots=t1 2>&1' < /dev/null",
  '1624295 1624246    3269 node /usr/local/bin/yarn --silent test:all --slots=t1',
  '1624872 1624295    3269 /bin/sh -c bash ../../../bin/test-parallel --slots=t1',
  '1624873 1624872    3269 /mnt/ddev-global-cache/n_prefix/shop-web/bin/node /var/www/html/tests/m2-hyva-playwright/node_modules/.bin/ts-node --transpile-only /var/www/html/tests/apps/shop/parallel/run.ts',
  '2339820 1624873    1205 npm exec playwright test --test-list /var/www/html/test-results/parallel/lanes/main/test-list.txt --workers=4',
  '2340336 2339820    1205 sh -c playwright test --test-list /var/www/html/test-results/parallel/lanes/main/test-list.txt --workers=4',
  '2340337 2340336    1205 /mnt/ddev-global-cache/n_prefix/shop-web/bin/node /var/www/html/tests/apps/node_modules/.bin/playwright test --test-list /var/www/html/test-results/parallel/lanes/main/test-list.txt --workers=4',
  '2342615 2340337    1199 /mnt/ddev-global-cache/n_prefix/shop-web/bin/node /var/www/html/tests/m2-hyva-playwright/node_modules/playwright/lib/common/process.js',
  '2343356 2342615    1197 /opt/playwright-browsers/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell --disable-field-trial-config',
  '2488660 2487194  111734 npm exec @playwright/mcp --no-sandbox --isolated --ignore-https-errors',
  '2488661 2488660  111734 sh -c playwright-mcp --no-sandbox --isolated --ignore-https-errors',
  '1598115 2741657    3335 node /var/www/html/tests/m2-hyva-playwright/node_modules/.bin/ts-node --transpile-only /var/www/html/tests/apps/shop/parallel/slot-agent.ts',
  '2464904 1598115    1118 npm exec playwright test --test-list /var/www/html/test-results/parallel/jobs/abc/test-list.txt --workers=1',
  '3000001 2487194       0 ps -eo pid=,ppid=,etimes=,args=',
].join('\n')

const FLEET = JSON.stringify([
  {
    project: 'shop', base: 'shop', slot: 'main',
    container: 'ddev-shop-web', kind: 'pkg-test',
    label: 'yarn --silent test:all --slots=t1', pid: 1624295, elapsed_s: 3540,
    owner: { kind: 'claude', pid: 2487194, name: 'shop-agent' },
  },
  {
    project: 'shop-t1', base: 'shop', slot: 't1',
    container: 'ddev-shop-t1-web', kind: 'playwright',
    label: 'npm exec playwright test --test-list test-list.txt --workers=1',
    pid: 2464904, elapsed_s: 1209,
    owner: { kind: 'supervisord', pid: 2741657, name: null },
  },
  { project: 7, note: 'off-shape: dropped' },
])

const BAND = {
  plugin: 'pb-board',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

/** `sh -c 'echo $PPID; exec ps …'` as the session process 2487194 runs it. */
const ownPs = (ps: string) => ({ exitCode: 0, stdout: `2487194\n${ps}\n` })

/** `/exit` typed at the prompt. */
const EXIT = {
  command: 'exit',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

test('a run is its top-most runner under this session, nothing else', () => {
  const runs = ownRunsFrom(`2487194\n${PS}\n`)

  expect(runs).toEqual([
    { pid: 1624295, kind: 'pkg-test', label: 'yarn --silent test:all --slots=t1', elapsedS: 3269 },
  ])

  // The child process.run started may sit under a helper: walked up to claude.
  const helper = `3100000\n${PS}\n3100000 2487194 1 /usr/bin/env sh -c x\n`

  expect(ownRunsFrom(helper).map(run => run.pid)).toEqual([1624295])

  // A Bash wrapper that names the command is the shell, not the run.
  const bare = [
    '10 1 100 claude',
    "11 10 50 /bin/bash -c source /root/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'npx playwright test --grep @smoke'",
    '12 11 49 node /app/node_modules/.bin/playwright test --grep @smoke',
  ].join('\n')

  expect(ownRunsFrom(`10\n${bare}\n`)).toEqual([
    { pid: 12, kind: 'playwright', label: 'playwright test --grep @smoke', elapsedS: 49 },
  ])

  expect(runnerKind('npm exec @playwright/mcp --no-sandbox')).toBe(null)
  expect(runnerKind('node /x/playwright/lib/common/process.js')).toBe(null)
  expect(runnerKind('vendor/bin/phpunit -c dev/tests')).toBe('phpunit')
  expect(runnerKind('python3 -m pytest -q')).toBe('pytest')
  expect(runnerKind('npx vitest')).toBe(null)
  expect(() => ownRunsFrom('not a pid\n')).toThrow()
})

test('the host view reads, groups and words like tests-running --short', () => {
  const fleet = parseFleet(FLEET)

  expect(fleet.length).toBe(2)
  expect(fleet[1]?.owner).toEqual({ kind: 'supervisord', pid: 2741657, name: null })
  expect(groupFleet(fleet)).toBe('shop main+t1 59m')
  expect(parseFleet('nope')).toEqual([])
  expect(parseFleet('{"a":1}')).toEqual([])
  expect([dur(45), dur(420), dur(3720)]).toEqual(['45s', '7m', '1h02m'])
  expect(
    bandLines(fleet, [{ pid: 1, kind: 'pkg-test', label: 'yarn test', elapsedS: 125 }]),
  ).toEqual([
    '🧪 tests: shop main+t1 59m',
    '⚠ test run in this session: yarn test 2m. Closing this session kills it.',
  ])
})

test('the band shows the host runs and this session\'s own; the pane lists them', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })

  world(on, { '/repo/readme.md': 'x' }, {}, argv =>
    argv[0] === 'tests-running'
      ? { exitCode: 0, stdout: FLEET }
      : argv[0] === 'sh'
        ? ownPs(PS)
        : null,
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^🧪/ }))?.text).toBe(
    '🧪 tests: shop main+t1 59m',
  )
  expect((await ui.find({ type: 'Text', text: /^⚠/ }))?.text).toBe(
    '⚠ test run in this session: yarn --silent test:all --slots=t1 54m. Closing this session kills it.',
  )
  await ui.unmount()

  // A survey keeps the band: nothing of ours.
  ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: 'terminal',
  })
  expect(await ui.find({ type: 'Text', text: /^🧪/ })).toBeUndefined()
  await ui.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await pane.find({ type: 'Text', text: /^TESTS/ }))?.text).toBe('TESTS')
  expect(
    (await pane.find({ type: 'Text', text: /^shop-t1 t1 playwright/ }))?.text,
  ).toMatch(/^shop-t1 t1 playwright\s*$/)
  expect(await pane.find({ type: 'Text', text: /^supervisord · npm exec playwright/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^claude shop-agent · yarn --silent/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^20m$|^ 20m$/ })).toBeDefined()
  await pane.unmount()
})

test('with no tests-running and no runs the band draws nothing of ours', async ($, on) => {
  const clock = mock.clock(on, { now: 6_000_000 })
  const asked: string[] = []

  world(on, { '/c/readme.md': 'x' }, {}, argv => {
    asked.push(argv[0] ?? '')

    return argv[0] === 'sh' ? ownPs('2487194 1 10 claude') : null
  })
  await $.session.start({ cwd: '/c', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /^🧪|^⚠/ })).toBeUndefined()
  await ui.unmount()

  // A missing script is not asked again at every poll.
  await clock.advance(60_000)
  expect(asked.filter(one => one === 'tests-running').length).toBe(1)
})

test('/exit asks once while this session runs tests; again within 20s quits', async ($, on) => {
  const clock = mock.clock(on, { now: 7_000_000 })
  let ps: string | null = PS

  world(on, { '/w/readme.md': 'x' }, {}, argv =>
    argv[0] === 'sh' ? (ps === null ? null : ownPs(ps)) : null,
  )
  on('command.run', () => ({ text: 'EXITED' }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const first = await $.command.run(EXIT)

  expect(first.text).toBe(
    exitWarning([
      { pid: 1624295, kind: 'pkg-test', label: 'yarn --silent test:all --slots=t1', elapsedS: 3269 },
    ]),
  )
  expect(first.text).toContain('Type /exit again within 20s to quit anyway.')
  await clock.advance(5000)
  expect((await $.command.run(EXIT)).text).toBe('EXITED')

  // Past the window: asked again.
  await $.command.run(EXIT)
  await clock.advance(21_000)
  expect((await $.command.run(EXIT)).text).toContain('again within 20s')

  // No run: quits at once.
  ps = '2487194 1 10 claude'
  await clock.advance(21_000)
  expect((await $.command.run(EXIT)).text).toBe('EXITED')

  // ps fails: never trapped.
  ps = null
  expect((await $.command.run(EXIT)).text).toBe('EXITED')
})
