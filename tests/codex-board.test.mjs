import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { boardDir, foldSession } from '../codex/feed.mjs'

const program = (file) => fileURLToPath(new URL('../codex/' + file, import.meta.url))
const Reporter = createRequire(import.meta.url)('../reporter/pb-board-reporter.cjs')

test('board reads HCF progress, Codex lifecycle hooks, and Playwright reporter events', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'pb-board-test-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', repo])
  const plan = join(repo, '.claude', 'plans', 'release')
  mkdirSync(plan, { recursive: true })
  writeFileSync(join(plan, '_plan.md'), '# Plan: Release\n\n## Status\nin_progress\n')
  writeFileSync(join(plan, '001-verify.md'),
    '# Task 001: Verify release\n\n**Status**: in_progress\n\n## Requirements\n- [x] Test\n- [ ] Deploy\n')

  const session = 'session-123'
  function hook(hook_event_name, agent_id) {
    const input = JSON.stringify({
      cwd: repo, session_id: session, hook_event_name, agent_id,
      agent_type: 'worker', last_assistant_message: 'private content',
    })
    execFileSync(process.execPath, [program('record.mjs')], { input })
  }
  hook('SessionStart')
  hook('SubagentStart', 'agent-1')
  hook('SubagentStart', 'agent-2')
  hook('SubagentStop', 'agent-2')
  assert.doesNotMatch(readFileSync(join(boardDir(repo), 'codex', session + '.jsonl'), 'utf8'),
    /private content/)

  const reporter = new Reporter()
  const example = {
    id: 'profile', title: 'updates profile', location: { file: 'profile.spec.ts' },
    titlePath: () => ['', '', 'profile.spec.ts', 'updates profile'],
    outcome: () => 'expected', expectedStatus: 'passed', retries: 0,
  }
  reporter.onBegin({ rootDir: repo, workers: 2 }, { allTests: () => [example] })
  reporter.onTestBegin(example, { workerIndex: 0, parallelIndex: 0, retry: 0 })
  const board = () => execFileSync(process.execPath, [program('board.mjs'), '--cwd', repo, '--once'], {
    encoding: 'utf8',
  })
  const running = board()
  assert.match(running, /PLAN  Release  in_progress/)
  assert.match(running, /▶ 001 Verify release  1\/2/)
  assert.match(running, /AGENTS  1\n▶ worker .*agent-1/)
  assert.doesNotMatch(running, /agent-2/)
  assert.match(running, /PLAYWRIGHT  running/)
  assert.match(running, /w0 profile.spec.ts › updates profile/)

  reporter.onTestEnd(example, { workerIndex: 0, parallelIndex: 0, retry: 0, status: 'passed' })
  reporter.onEnd({ status: 'passed' })
  hook('SessionEnd')
  const finished = board()
  assert.match(finished, /AGENTS  0/)
  assert.match(finished, /PLAYWRIGHT  passed/)
  assert.match(finished, /1\/1  ✓1/)
})

test('foldSession tolerates partial lines and clears agents at session boundaries', () => {
  const text = [
    { type: 'SessionStart', at: 1 },
    { type: 'SubagentStart', at: 2, id: 'old' },
    { type: 'SessionStart', at: 3 },
    { type: 'SubagentStart', at: 4, id: 'new' },
  ].map(JSON.stringify).join('\n') + '\n{"partial"'
  assert.deepEqual(foldSession(text), {
    active: true, lastAt: 4, agents: [{ type: 'SubagentStart', at: 4, id: 'new' }],
  })
})
