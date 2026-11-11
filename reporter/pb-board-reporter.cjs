// Playwright reporter feeding the pb-board pane: one JSON line per event.
//
// Added beside a project's own reporters, never in their place:
//   PW_TEST_REPORTER=/abs/path/pb-board-reporter.cjs npx playwright test
//
// Writes <git dir>/pb-board/playwright.jsonl (the repository the Playwright
// config lies in), or PB_BOARD_FILE when set. The git dir is on the bind
// mount, so a run inside a container is read by a session on the host.
// Never throws: a reporter that fails must not fail the run.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function gitDirOf(start) {
  let dir = path.resolve(start)

  for (let i = 0; i < 24; i++) {
    const dot = path.join(dir, '.git')

    try {
      const stat = fs.statSync(dot)

      if (stat.isDirectory()) {
        return dot
      }

      const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'))

      if (named) {
        return path.resolve(dir, named[1].trim())
      }
    } catch {
      // Not here: keep walking.
    }

    const up = path.dirname(dir)

    if (up === dir) {
      break
    }

    dir = up
  }

  return null
}

class PbBoardReporter {
  constructor() {
    this.file = null
  }

  write(line, isFirst) {
    if (this.file === null) {
      return
    }

    try {
      const text = JSON.stringify({ ...line, ts: Date.now() }) + '\n'

      if (isFirst) {
        fs.writeFileSync(this.file, text)
      } else {
        fs.appendFileSync(this.file, text)
      }
    } catch {
      this.file = null
    }
  }

  onBegin(config, suite) {
    try {
      const root = config.rootDir || process.cwd()
      const base = gitDirOf(root) || path.join(root, 'test-results')

      this.file =
        process.env.PB_BOARD_FILE ||
        path.join(base, 'pb-board', 'playwright.jsonl')
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
    } catch {
      this.file = null
    }

    let total = 0

    try {
      total = suite.allTests().length
    } catch {
      // Left at 0.
    }

    this.write({ t: 'begin', total, workers: config.workers || 1 }, true)
  }

  title(test) {
    try {
      // ['', project, file, ...describes, title]
      const parts = test.titlePath().filter(Boolean)
      const file = path.basename(test.location.file)
      const at = parts.findIndex(part => part.endsWith(file))

      return [file, ...parts.slice(at + 1)].join(' › ')
    } catch {
      return test.title
    }
  }

  onTestBegin(test, result) {
    this.write({
      t: 'start',
      id: test.id,
      title: this.title(test),
      worker: result.parallelIndex ?? result.workerIndex,
      retry: result.retry,
    })
  }

  onTestEnd(test, result) {
    const hasFailed =
      result.status !== test.expectedStatus && result.status !== 'skipped'
    const willRetry =
      hasFailed && result.status !== 'interrupted' && result.retry < test.retries

    this.write({
      t: 'end',
      id: test.id,
      title: this.title(test),
      worker: result.parallelIndex ?? result.workerIndex,
      retry: result.retry,
      status: result.status,
      outcome: test.outcome(),
      final: !willRetry,
      duration: result.duration,
    })
  }

  onEnd(result) {
    this.write({ t: 'done', status: result.status })
  }

  printsToStdio() {
    return false
  }
}

module.exports = PbBoardReporter
