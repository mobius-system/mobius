const readline = require('readline')
const fs = require('fs')
const path = require('path')

function send(frame) { process.stdout.write(`${JSON.stringify(frame)}\n`) }
function response(id, result) { send({ jsonrpc: '2.0', id, result }) }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }) }

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  if (!line.trim()) return
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') {
    fs.mkdirSync(process.env.DSH_SESSION_ROOT, { recursive: true })
    fs.appendFileSync(path.join(process.env.DSH_SESSION_ROOT, 'initializations.jsonl'), `${JSON.stringify(frame.params)}\n`)
    response(frame.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fake' } })
    return
  }
  if (frame.method === 'session/prompt') {
    response(frame.id, { messageId: `message-${Date.now()}` })
    const sessionId = frame.params.sessionId
    notify('session.status', { sessionId, status: 'running' })
    notify('session.event', {
      sessionId,
      event: { type: 'assistant/message', seq: Date.now(), time: Date.now(), data: { message: { content: [{ type: 'text', text: 'fake answer' }] } } },
    })
    setTimeout(() => {
      notify('session.event', { sessionId, event: { type: 'turn/end', seq: Date.now(), time: Date.now(), data: { reason: { kind: 'completed' } } } })
      notify('session.status', { sessionId, status: 'idle' })
    }, 25)
    return
  }
  if (frame.method === 'shutdown') {
    response(frame.id, {})
    setTimeout(() => process.exit(0), 5)
  }
})
