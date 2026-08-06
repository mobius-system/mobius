const assert = require('node:assert/strict')
const { sortProjectSessions } = require('../frontend/src/services/project-session-order')

const sessions = [
  { session_id: 'finished-old', status: 'completed', completed_at: '2026-08-01T10:00:00Z', last_active: '2026-08-01T10:00:00Z' },
  { session_id: 'idle-open', status: 'active', agent_status: 'idle', last_active: '2026-08-02T10:00:00Z' },
  { session_id: 'running-old', status: 'active', agent_status: 'running', last_active: '2026-08-01T08:00:00Z' },
  { session_id: 'finished-new', status: 'completed', completed_at: '2026-08-03T10:00:00Z', last_active: '2026-08-03T10:00:00Z' },
  { session_id: 'running-new', status: 'active', agent_status: 'running', last_active: '2026-08-03T08:00:00Z' },
]

assert.deepEqual(sortProjectSessions(sessions).map((session) => session.session_id), [
  'running-new',
  'running-old',
  'idle-open',
  'finished-new',
  'finished-old',
])

console.log('project session ordering tests passed')
