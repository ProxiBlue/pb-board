#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bar, elapsed, foldProgress, parsePlan, parseTask } from '../hooks/parse.ts'
import { boardDir, entries, optionalRead, readSession, validId } from './feed.mjs'

const { values } = parseArgs({ options: {
  cwd: { type: 'string' },
  plan: { type: 'string' },
  session: { type: 'string' },
  once: { type: 'boolean' },
  help: { type: 'boolean' },
} })

if (values.help) {
  console.log('Usage: node codex/board.mjs [--cwd REPO] [--plan NAME] [--session ID] [--once]')
  process.exit(0)
}
for (const key of ['plan', 'session']) {
  if (values[key] !== undefined && !validId(values[key])) {
    console.error('Invalid --' + key + ' value.')
    process.exit(1)
  }
}

const cwd = resolve(values.cwd ?? process.cwd())
const base = boardDir(cwd)
if (!base) {
  console.error('pb-board needs a Git worktree. Run it there or pass --cwd.')
  process.exit(1)
}
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
const plans = join(root, '.claude', 'plans')
const tally = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
const clean = (line) => String(line).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const marks = { completed: '✓', done: '✓', in_progress: '▶', blocked: '✗' }

function readPlan(name) {
  const folder = join(plans, name)
  const file = join(folder, '_plan.md')
  const content = optionalRead(file)
  if (!content) return null
  const plan = parsePlan(content)
  const modified = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0
  return { ...plan, folder, modified }
}

function withTasks(plan) {
  if (!plan) return null
  const rows = new Map(plan.rows.map((row) => [row.id, row]))
  for (const entry of entries(plan.folder)) {
    const task = /^(\d{1,4}[a-z]?)-(.+)\.md$/.exec(entry.name)
    if (!entry.isFile() || !task) continue
    const path = join(plan.folder, entry.name)
    const taskText = optionalRead(path)
    const parsed = parseTask(taskText)
    const [, id, slug] = task
    rows.set(id, {
      ...parsed, id,
      title: parsed.title || rows.get(id)?.title || /^#\s+\d+\s+(.+)$/m.exec(taskText)?.[1] ||
        slug.replaceAll('-', ' '),
      status: parsed.status || rows.get(id)?.status || 'pending',
    })
  }
  return { ...plan, rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

function selectedPlan() {
  if (values.plan) return withTasks(readPlan(values.plan))
  const priority = { in_progress: 2, ready: 1 }
  const [plan] = entries(plans).filter((entry) => entry.isDirectory())
    .map((entry) => readPlan(entry.name)).filter(Boolean)
    .sort((a, b) => (priority[b.status] ?? 0) - (priority[a.status] ?? 0) || b.modified - a.modified)
  return withTasks(plan)
}

function snapshot(height = Infinity) {
  const now = Date.now()
  const lines = ['PB BOARD · CODEX', '']
  const detailLimit = Math.max(0, Math.floor((height - 9) / 3))
  const plan = selectedPlan()
  if (plan) {
    const done = plan.rows.filter((row) => ['done', 'completed'].includes(row.status)).length
    lines.push('PLAN  ' + plan.title + '  ' + (plan.status || 'unspecified'),
      bar(done, plan.rows.length, 24) + '  ' + done + '/' + plan.rows.length + ' tasks  ·  ' +
      tally(plan.rows, 'done') + '/' + tally(plan.rows, 'total') + ' requirements')
    for (const row of plan.rows.slice(0, detailLimit)) {
      const progress = row.total ? '  ' + row.done + '/' + row.total : ''
      lines.push((marks[row.status] ?? '·') + ' ' + row.id + ' ' + row.title + progress)
    }
    if (plan.rows.length > detailLimit) lines.push('… ' + (plan.rows.length - detailLimit) + ' more')
  } else {
    lines.push('PLAN  ' + (values.plan ? 'Plan not found: ' + values.plan : 'No HCF plan found'))
  }

  const session = readSession(join(base, 'codex'), values.session)
  lines.push('', 'AGENTS  ' + session.agents.length)
  if (!session.active) lines.push('Waiting for Codex session hooks')
  for (const agent of session.agents.slice(0, detailLimit)) {
    lines.push('▶ ' + (agent.role || 'agent') + ' ' + elapsed(now - agent.at) + '  ' + agent.id)
  }
  if (session.agents.length > detailLimit) lines.push('… ' + (session.agents.length - detailLimit) + ' more')

  const tests = foldProgress(optionalRead(process.env.PB_BOARD_FILE || join(base, 'playwright.jsonl')))
  lines.push('', 'PLAYWRIGHT  ' + (tests ? tests.status || 'running' : 'No run reported'))
  if (tests) {
    const done = tests.passed + tests.failed + tests.flaky + tests.skipped
    lines.push(bar(done, tests.total, 24) + '  ' + done + '/' + tests.total +
      '  ✓' + tests.passed + ' ✗' + tests.failed + ' ~' + tests.flaky + ' -' + tests.skipped)
    const details = [
      ...tests.running.map((row) => '▶ w' + row.worker + ' ' + row.title + '  ' + elapsed(now - row.startedAt)),
      ...tests.failures.map((row) => '✗ ' + row.title),
    ]
    lines.push(...details.slice(0, detailLimit))
    if (details.length > detailLimit) lines.push('… ' + (details.length - detailLimit) + ' more')
  }

  return lines.map(clean).join('\n')
}

function draw() {
  if (values.once || !process.stdout.isTTY) console.log(snapshot())
  else {
    const width = process.stdout.columns || 80
    const height = process.stdout.rows || 24
    const lines = snapshot(height).split('\n').slice(0, height)
    process.stdout.write('\x1b[H\x1b[2J' + lines.map((line) => line.slice(0, width - 1)).join('\n'))
  }
}

draw()
if (!values.once && process.stdout.isTTY) setInterval(draw, 750)
