/**
 * agents/events.js — neutral event bus for agent backends.
 *
 * This module belongs to the agent infrastructure layer. It only publishes
 * raw agent events and deliberately knows nothing about Mobius business
 * concepts such as sessions_v2, admin settings, titles, or repositories.
 */
const EventEmitter = require('events')

const agentEvents = new EventEmitter()
agentEvents.setMaxListeners(0)

function emitAgentRawEntry(payload) {
  agentEvents.emit('raw_entry', payload)
}

function onAgentRawEntry(listener) {
  agentEvents.on('raw_entry', listener)
  return () => agentEvents.off('raw_entry', listener)
}

module.exports = {
  emitAgentRawEntry,
  onAgentRawEntry,
}
