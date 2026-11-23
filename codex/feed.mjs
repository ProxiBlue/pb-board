import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const validId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

export function boardDir(cwd) {
  try {
    return join(execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    }).trim(), 'pb-board')
  } catch {
    return null
  }
}

export function optionalRead(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

export function entries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function foldSession(text) {
  const agents = new Map()
  let active = false
  let lastAt = 0
  for (const line of text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || !Number.isFinite(event.at)) continue
    lastAt = Math.max(lastAt, event.at)
    switch (event.type) {
      case 'SessionStart':
        active = true
        agents.clear()
        break
      case 'SessionEnd':
        active = false
        agents.clear()
        break
      case 'SubagentStart':
        if (active && validId(event.id)) agents.set(event.id, event)
        break
      case 'SubagentStop':
        agents.delete(event.id)
        break
    }
  }
  return { active, lastAt, agents: [...agents.values()] }
}

export function readSession(directory, selected) {
  const file = (id) => join(directory, id + '.jsonl')
  if (selected) return foldSession(optionalRead(file(selected)))
  const candidates = entries(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name.slice(0, -6))
    .filter(validId)
    .map((id) => ({ id, modified: statSync(file(id), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.modified - a.modified)
  for (const { id } of candidates) {
    const session = foldSession(optionalRead(file(id)))
    if (session.active) return { ...session, id }
  }
  return { active: false, agents: [] }
}
