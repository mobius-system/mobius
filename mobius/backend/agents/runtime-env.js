function runtimeEnvEntries(value) {
  if (value == null) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtimeEnv must be an object')
  }
  return Object.entries(value).map(([key, raw]) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid runtime environment key: ${key}`)
    if (typeof raw !== 'string' || raw.length > 8192 || raw.includes('\0')) {
      throw new Error(`Invalid runtime environment value for ${key}`)
    }
    return [key, raw]
  })
}

module.exports = { runtimeEnvEntries }
