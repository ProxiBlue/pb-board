import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardDir, validId } from './feed.mjs'

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const { cwd, session_id: session, hook_event_name: type, agent_id: id } = input
  const agent = type === 'SubagentStart' || type === 'SubagentStop'
  const lifecycle = type === 'SessionStart' || type === 'SessionEnd'
  if (typeof cwd === 'string' && validId(session) && (lifecycle || (agent && validId(id)))) {
    const base = boardDir(cwd)
    if (base) {
      const directory = join(base, 'codex')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const event = { type, at: Date.now() }
      if (agent) {
        event.id = id
        event.role = typeof input.agent_type === 'string' ? input.agent_type.slice(0, 80) : 'agent'
      }
      appendFileSync(join(directory, session + '.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
    }
  }
} catch {
  // Board telemetry must never interfere with a Codex hook.
}
