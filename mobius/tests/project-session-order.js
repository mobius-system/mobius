const assert = require('node:assert/strict')
const {
  projectItemOrder,
  projectSessionPreview,
  sortProjectSessions,
} = require('../frontend/src/services/project-session-order')

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

assert.deepEqual(projectSessionPreview(sessions, true).map((session) => session.session_id), [
  'running-new',
  'running-old',
])
assert.deepEqual(projectSessionPreview(sessions.filter((session) => session.agent_status !== 'running'), true).map((session) => session.session_id), [
  'idle-open',
])
assert.deepEqual(projectSessionPreview(sessions, true, true).map((session) => session.session_id), [
  'running-new',
  'running-old',
])

const projectItems = [
  { id: 'starred', starred: true, status: 'active', last_active: '2026-08-05T12:00:00Z', running_session_count: 0 },
  { id: 'running-old', status: 'active', last_active: '2026-08-01T12:00:00Z', running_session_count: 1 },
  { id: 'open-old', status: 'active', last_active: '2026-07-01T12:00:00Z', active_session_count: 1, running_session_count: 0 },
  { id: 'recent', status: 'active', last_active: '2026-08-04T12:00:00Z', running_session_count: 0 },
  { id: 'completed', status: 'completed', completed_at: '2026-08-06T12:00:00Z', running_session_count: 0 },
]
assert.deepEqual([...projectItems].sort(projectItemOrder).map((item) => item.id), [
  'running-old',
  'open-old',
  'starred',
  'recent',
  'completed',
])

console.log('project card ordering and preview tests passed')
