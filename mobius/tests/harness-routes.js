const assert = require('assert')
const express = require('express')
const fs = require('fs')
const http = require('http')
const jwt = require('jsonwebtoken')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-routes-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.HARNESS_ORCHESTRATOR_ENABLED = '0'

const { db } = require('../db')
const { JWT_SECRET } = require('../backend/config')
const { profilesRouter, runsRouter } = require('../backend/routes/harnesses')
const { setup, rosterRequest, cleanup } = require('./harness/phase1-fixture')

async function main() {
  const fixture = setup(db, tempRoot, 'routes')
  const app = express()
  app.use(express.json())
  app.use('/api/harness-profiles', profilesRouter)
  app.use('/api/harness-runs', runsRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const token = jwt.sign({ id: fixture.userId }, JWT_SECRET, { expiresIn: '1h' })
  const request = async (url, options = {}) => {
    const response = await fetch(`${base}${url}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    })
    const body = await response.json()
    return { response, body }
  }

  try {
    const profiles = await request(`/api/harness-profiles?project_id=${fixture.projectId}`)
    assert.equal(profiles.response.status, 200)
    assert.ok(profiles.body.some((profile) => profile.backend === 'codex'))
    assert.ok(profiles.body.some((profile) => profile.backend === 'claude-code'))

    const invalid = await request('/api/harness-runs/estimate', {
      method: 'POST', body: JSON.stringify({ ...rosterRequest(fixture, 'single'), roster: { main_member_key: 'missing', members: rosterRequest(fixture, 'single').roster.members } }),
    })
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.body.code, 'unique_main_required')

    const draft = rosterRequest(fixture, 'multi')
    const estimate = await request('/api/harness-runs/estimate', { method: 'POST', body: JSON.stringify(draft) })
    assert.equal(estimate.response.status, 200)
    assert.ok(estimate.body.estimate_id)

    const created = await request('/api/harness-runs', {
      method: 'POST',
      body: JSON.stringify({
        ...draft,
        request_id: 'route-create-request',
        acknowledged_estimate: {
          estimate_id: estimate.body.estimate_id,
          shown_cost_usd_range: estimate.body.estimated_cost_usd_range,
        },
      }),
    })
    assert.equal(created.response.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.run.execution_mode, 'multi')
    assert.equal(created.body.members.length, 2)

    const list = await request(`/api/harness-runs?issue_id=${fixture.issueId}`)
    assert.equal(list.response.status, 200)
    assert.equal(list.body[0].id, created.body.run.id)

    const snapshot = await request(`/api/harness-runs/${created.body.run.id}`)
    assert.equal(snapshot.response.status, 200)
    assert.equal(snapshot.body.nodes[0].task_contract.workspace.mode, 'read_only')
    assert.equal(snapshot.body.run.actual_cost_usd, 0)
    assert.equal(snapshot.body.run.cost_telemetry_status, 'not_started')
    assert.deepEqual(snapshot.body.run.acknowledged_estimate.cost_range, estimate.body.estimated_cost_usd_range)
    assert.deepEqual(snapshot.body.run.acknowledged_estimate.duration_range, estimate.body.estimated_duration_seconds_range)
    assert.ok(snapshot.body.events.every((event) => event.payload && !Array.isArray(event.payload)))

    console.log('harness Phase 1 route tests passed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
