import type { FleetRun, OwnRun } from '../types'

/**
 * Test runners, the same patterns as the host's `tests-running` script
 * script: a process whose command line
 * matches is a runner, and the top-most one of a chain is the run.
 */
const RUNNERS: readonly (readonly [string, RegExp])[] = [
  ['playwright', /(^|[\s/])playwright(\.js)?\s+test(\s|$)|playwright\/cli\.js\s+test(\s|$)/],
  ['pps-parallel', /(^|[\s/])bin\/test-parallel(\s|$)/],
  ['phpunit', /(^|[\s/])(phpunit|paratest)(\s|$)/],
  ['magento-tests', /\bdev:tests:run\b/],
  ['pytest', /(^|[\s/])(py\.test|pytest)(\s|$)|-m\s+pytest(\s|$)/],
  ['vitest', /(^|[\s/])vitest(\.mjs)?\s+run(\s|$)/],
  ['jest', /(^|[\s/])jest(\.js)?(\s|$)/],
  ['pkg-test', /(^|[\s/])(yarn|npm|pnpm)(\.js)?(\s+--?\S+)*\s+(run\s+)?test(:\S+)?(\s|$)/],
]

const EXCLUDE = new RegExp(
  'playwright-mcp|@playwright/mcp|lib/common/process\\.js|chrome-headless|chromium|' +
    '(^|\\s)--(watch|list|version|help)(\\s|=|$)|tests-running|test-run-stop-guard|' +
    '(^|[\\s/])(grep|rg|ugrep|pgrep|ps|less|tail|cat|vim?|nano)(\\s)',
)

/**
 * The Bash tool's own wrapper (`bash -c source …/shell-snapshots/snapshot-…
 * && eval '<the command>'`) carries the whole command line it runs: it is the
 * session's shell, never the run, so the runner beneath it is.
 */
const BASH_TOOL_WRAPPER = /\/shell-snapshots\/snapshot-/

export type Proc = { pid: number; ppid: number; etimes: number; args: string }

/** Which runner a command line is, or null. */
export function runnerKind(args: string): string | null {
  if (EXCLUDE.test(args) || BASH_TOOL_WRAPPER.test(args)) {
    return null
  }

  for (const [kind, rx] of RUNNERS) {
    if (rx.test(args)) {
      return kind
    }
  }

  return null
}

/** `ps -eo pid=,ppid=,etimes=,args=` lines, read. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []

  for (const line of text.split('\n')) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)

    if (found !== null) {
      out.push({
        pid: Number(found[1]),
        ppid: Number(found[2]),
        etimes: Number(found[3]),
        args: found[4] ?? '',
      })
    }
  }

  return out
}

const argv0 = (args: string): string => {
  const first = args.split(/\s+/)[0] ?? ''

  return first.slice(first.lastIndexOf('/') + 1)
}

/**
 * The claude process at or above `pid`: the child `$.process.run` started
 * names its parent, which is this session's process unless something sat
 * between; the first ancestor run as `claude` wins, else `pid` itself.
 */
export function sessionPid(procs: readonly Proc[], pid: number): number {
  const byPid = new Map(procs.map(one => [one.pid, one]))
  let at = byPid.get(pid)

  for (let i = 0; i < 6 && at !== undefined; i++) {
    if (argv0(at.args) === 'claude') {
      return at.pid
    }

    at = byPid.get(at.ppid)
  }

  return pid
}

/** A command line, short: paths cut to their last part, the interpreter dropped. */
export function labelOf(args: string): string {
  const parts = args.split(/\s+/).filter(one => one !== '').map(one =>
    one.startsWith('/') && one.slice(1).includes('/')
      ? one.slice(one.lastIndexOf('/') + 1)
      : one,
  )

  while (
    parts.length > 0 &&
    ['node', 'php', 'python', 'python3', 'sh', 'bash', '-c', 'exec'].includes(parts[0] ?? '')
  ) {
    parts.shift()
  }

  const text = parts.join(' ')

  return text.length <= 70 ? text : `${text.slice(0, 67)}...`
}

/**
 * The test runs started under the session process `root`: each runner below
 * it with no runner between it and `root`, oldest first.
 */
export function ownRuns(procs: readonly Proc[], root: number): OwnRun[] {
  const byPid = new Map(procs.map(one => [one.pid, one]))
  const kinds = new Map<number, string>()

  for (const one of procs) {
    const kind = runnerKind(one.args)

    if (kind !== null) {
      kinds.set(one.pid, kind)
    }
  }

  const out: OwnRun[] = []

  for (const [pid, kind] of kinds) {
    let at = byPid.get(pid)?.ppid
    let isUnder = false
    let isTop = true

    for (let i = 0; i < 64 && at !== undefined && at > 1; i++) {
      if (at === root) {
        isUnder = true
        break
      }

      if (kinds.has(at)) {
        isTop = false
      }

      at = byPid.get(at)?.ppid
    }

    const one = byPid.get(pid)

    if (isUnder && isTop && one !== undefined) {
      out.push({ pid, kind, label: labelOf(one.args), elapsedS: one.etimes })
    }
  }

  return out.sort((a, b) => b.elapsedS - a.elapsedS)
}

/**
 * The script's `$PPID` line, then `ps` lines: this session's own runs.
 * Throws when the text holds no parent line.
 */
export function ownRunsFrom(text: string): OwnRun[] {
  const [head, ...rest] = text.split('\n')
  const parent = Number((head ?? '').trim())

  if (!Number.isInteger(parent) || parent <= 1) {
    throw new Error('no parent pid')
  }

  const procs = parsePs(rest.join('\n'))

  return ownRuns(procs, sessionPid(procs, parent))
}

/** `tests-running --json`, read; anything off-shape is dropped, never thrown. */
export function parseFleet(text: string): FleetRun[] {
  let data: unknown

  try {
    data = JSON.parse(text)
  } catch {
    return []
  }

  if (!Array.isArray(data)) {
    return []
  }

  const out: FleetRun[] = []

  for (const item of data) {
    if (item === null || typeof item !== 'object') {
      continue
    }

    const one = item as Record<string, unknown>
    const owner = (one['owner'] ?? {}) as Record<string, unknown>

    if (typeof one['project'] !== 'string' || typeof one['elapsed_s'] !== 'number') {
      continue
    }

    out.push({
      project: one['project'],
      base: typeof one['base'] === 'string' ? one['base'] : one['project'],
      slot: typeof one['slot'] === 'string' ? one['slot'] : 'main',
      container: typeof one['container'] === 'string' ? one['container'] : '',
      kind: typeof one['kind'] === 'string' ? one['kind'] : 'test',
      label: typeof one['label'] === 'string' ? one['label'] : '',
      pid: typeof one['pid'] === 'number' ? one['pid'] : 0,
      elapsedS: one['elapsed_s'],
      owner: {
        kind: typeof owner['kind'] === 'string' ? owner['kind'] : 'shell',
        pid: typeof owner['pid'] === 'number' ? owner['pid'] : null,
        name: typeof owner['name'] === 'string' ? owner['name'] : null,
      },
    })
  }

  return out
}

/** Seconds as `tests-running` writes them: 45s, 7m, 1h02m. */
export function dur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)

  if (h > 0) {
    return `${h}h${String(m).padStart(2, '0')}m`
  }

  return m > 0 ? `${m}m` : `${s}s`
}

/** `shop main+t1 59m · blog main 3m`: as `tests-running --short`. */
export function groupFleet(runs: readonly FleetRun[]): string {
  const groups = new Map<string, { slots: string[]; elapsedS: number }>()

  for (const run of runs) {
    const group = groups.get(run.base) ?? { slots: [], elapsedS: 0 }

    if (!group.slots.includes(run.slot)) {
      group.slots.push(run.slot)
    }

    group.elapsedS = Math.max(group.elapsedS, run.elapsedS)
    groups.set(run.base, group)
  }

  return [...groups]
    .map(([base, group]) => `${base} ${group.slots.join('+')} ${dur(group.elapsedS)}`)
    .join(' · ')
}

export const ownerText = (owner: FleetRun['owner']): string =>
  owner.kind === 'claude'
    ? owner.name !== null
      ? `claude ${owner.name}`
      : `claude pid ${owner.pid ?? '?'}`
    : owner.kind

/** The band's lines: the host's view first, then this session's own runs. */
export function bandLines(fleet: readonly FleetRun[], own: readonly OwnRun[]): string[] {
  const lines: string[] = []

  if (fleet.length > 0) {
    lines.push(`🧪 tests: ${groupFleet(fleet)}`)
  }

  for (const run of own) {
    lines.push(
      `⚠ test run in this session: ${run.label} ${dur(run.elapsedS)}. Closing this session kills it.`,
    )
  }

  return lines
}

/** How long a first /exit stays armed for the second. */
export const EXIT_CONFIRM_MS = 20_000

/** What the first /exit answers while this session's runs are going. */
export function exitWarning(own: readonly OwnRun[]): string {
  return [
    `Test run${own.length === 1 ? '' : 's'} going in this session; quitting kills ${own.length === 1 ? 'it' : 'them'}:`,
    ...own.map(run => `  ${run.kind} ${dur(run.elapsedS)}: ${run.label}`),
    `Type /exit again within ${EXIT_CONFIRM_MS / 1000}s to quit anyway.`,
  ].join('\n')
}
