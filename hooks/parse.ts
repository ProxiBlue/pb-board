import type { TaskRow, TestRow, TestState, TestsView } from '../types'

const PLAN_IN_PATH = /((?:[^\s'"`=:(]*\/)?\.claude\/plans\/[A-Za-z0-9._-]+)(?=[\/\s'"`)]|$)/

/** Joins a path onto a directory, folding `.` and `..`. */
export function resolvePath(base: string, path: string): string {
  const from = path.startsWith('/') ? path : `${base}/${path}`
  const out: string[] = []

  for (const part of from.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      out.pop()
    } else {
      out.push(part)
    }
  }

  return `/${out.join('/')}`
}

/** The plan folder a path or a shell command names, absolute, if any. */
export function planDirIn(text: string, cwd: string): string | null {
  const found = PLAN_IN_PATH.exec(text)

  if (found === null || found[1] === undefined) {
    return null
  }

  // A home-relative or variable path is not resolved here: left alone.
  return /^[~$]/.test(found[1]) ? null : resolvePath(cwd, found[1])
}

/** The directories a shell command changes into, absolute. */
export function cdTargets(command: string, cwd: string): string[] {
  const out: string[] = []

  for (const found of command.matchAll(/(?:^|[;&|(]\s*|\s)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    const raw = (found[1] ?? '').replace(/^["']|["']$/g, '')

    if (raw !== '' && !raw.startsWith('~') && !raw.startsWith('$') && raw !== '-') {
      out.push(resolvePath(cwd, raw))
    }
  }

  return out
}

export const isPlaywrightRun = (command: string): boolean =>
  /\bplaywright\b[^;&|]*\btest\b/.test(command)

export type PlanHead = {
  title: string
  status: string
  rows: Pick<TaskRow, 'id' | 'title' | 'deps' | 'status'>[]
}

/** Reads `_plan.md`: its title, `## Status` and the Task Overview table. */
export function parsePlan(text: string): PlanHead {
  const lines = text.split('\n')
  const title = /^#\s+(?:Plan:\s*)?(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  let status = ''
  let isTaskTable = false
  const rows: PlanHead['rows'] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (status === '' && /^##\s+Status\s*$/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = (lines[j] ?? '').trim()

        if (next.startsWith('#')) {
          break
        }

        if (next !== '') {
          status = next.toLowerCase().replace(/[^a-z_]/g, '')
          break
        }
      }
    }

    if (/^##\s/.test(line)) {
      isTaskTable = /^##\s+Task/i.test(line)
    }

    const cells = /^\|\s*(\d{1,4}[a-z]?)\s*\|(.*)\|\s*$/.exec(line)

    if (isTaskTable && cells !== null) {
      const rest = (cells[2] ?? '').split('|').map(cell => cell.trim())
      const rowStatus = rest.length >= 3 ? (rest[rest.length - 1] ?? '') : ''
      const deps = rest.length >= 3 ? (rest[rest.length - 2] ?? '') : ''
      const head = rest.slice(0, Math.max(1, rest.length - 2)).join(' | ')

      rows.push({
        id: cells[1] ?? '',
        title: head.replace(/`/g, ''),
        deps: deps === '-' ? '' : deps,
        status: rowStatus.toLowerCase().replace(/[^a-z_]/g, ''),
      })
    }
  }

  return { title, status, rows }
}

/** Reads one task file: status, retries and its requirement checkboxes. */
export function parseTask(text: string): Omit<TaskRow, 'id'> {
  const title =
    /^#\s+Task\s+\S+?:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/`/g, '') ?? ''
  const status =
    /^\*\*Status\*\*:\s*([A-Za-z_]+)/m.exec(text)?.[1]?.toLowerCase() ?? ''
  const deps = /^\*\*Depends on\*\*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const retries = Number(/^\*\*Retry count\*\*:\s*(\d+)/m.exec(text)?.[1] ?? 0)
  const start = text.search(/^##\s+Requirements/m)
  let done = 0
  let total = 0

  if (start >= 0) {
    const body = text.slice(start).split('\n').slice(1)

    for (const line of body) {
      if (/^##\s/.test(line)) {
        break
      }

      const box = /^\s*[-*]\s+\[([ xX])\]/.exec(line)

      if (box !== null) {
        total += 1
        done += box[1] === ' ' ? 0 : 1
      }
    }
  }

  return {
    title,
    status,
    deps: /^(-|none)$/i.test(deps) ? '' : deps,
    done,
    total,
    retries,
  }
}

type Line = {
  t?: string
  id?: string
  title?: string
  total?: number
  workers?: number
  worker?: number
  retry?: number
  status?: string
  outcome?: string
  final?: boolean
  duration?: number
  ts?: number
}

/** Folds the reporter's JSON lines into the run as it stands. */
export function foldProgress(text: string): Omit<TestsView, 'file'> | null {
  let view: Omit<TestsView, 'file'> | null = null
  let tests = new Map<string, TestRow>()

  for (const raw of text.split('\n')) {
    if (raw === '') {
      continue
    }

    let line: Line

    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }

    const ts = line.ts ?? 0

    if (line.t === 'begin') {
      tests = new Map()
      view = {
        total: line.total ?? 0,
        workers: line.workers ?? 1,
        startedAt: ts,
        endedAt: null,
        lastAt: ts,
        status: null,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        running: [],
        failures: [],
      }
      continue
    }

    if (view === null) {
      continue
    }

    view.lastAt = Math.max(view.lastAt, ts)

    if (line.t === 'start' && line.id !== undefined) {
      tests.set(line.id, {
        id: line.id,
        title: line.title ?? line.id,
        state: 'running',
        worker: line.worker ?? 0,
        retry: line.retry ?? 0,
        startedAt: ts,
        durationMs: 0,
      })
    } else if (line.t === 'end' && line.id !== undefined) {
      const state: TestState =
        line.final === false
          ? 'retry'
          : line.outcome === 'flaky'
            ? 'flaky'
            : line.outcome === 'skipped' || line.status === 'skipped'
              ? 'skipped'
              : line.outcome === 'expected'
                ? 'passed'
                : 'failed'
      const was = tests.get(line.id)

      tests.set(line.id, {
        id: line.id,
        title: line.title ?? was?.title ?? line.id,
        state,
        worker: line.worker ?? was?.worker ?? 0,
        retry: line.retry ?? was?.retry ?? 0,
        startedAt: was?.startedAt ?? ts,
        durationMs: line.duration ?? 0,
      })
    } else if (line.t === 'done') {
      view.endedAt = ts
      view.status = line.status ?? 'done'
    }
  }

  if (view === null) {
    return null
  }

  for (const test of tests.values()) {
    if (test.state === 'running') {
      // A run that ended leaves no test running, whatever the file says.
      if (view.endedAt === null) {
        view.running.push(test)
      }
    } else if (test.state === 'passed') {
      view.passed += 1
    } else if (test.state === 'failed') {
      view.failed += 1
      view.failures.push(test)
    } else if (test.state === 'flaky') {
      view.flaky += 1
    } else if (test.state === 'skipped') {
      view.skipped += 1
    }
  }

  view.running.sort((a, b) => a.worker - b.worker)

  return view
}

/** `8s`, `1m12s`, `1h03m`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Cuts a text to `width` cells, an ellipsis in its last. */
export const clip = (text: string, width: number): string =>
  width <= 0
    ? ''
    : text.length <= width
      ? text
      : `${text.slice(0, Math.max(0, width - 1))}…`

/** A bar of `width` cells, `part` of `whole` filled. */
export function bar(part: number, whole: number, width: number): string {
  const cells = Math.max(0, width)
  const filled = whole <= 0 ? 0 : Math.min(cells, Math.round((part / whole) * cells))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}
