const SECRET_PLACEHOLDERS = new Set([
  '<API_KEY>',
  'REPLACE_WITH_ENV_OR_SECRET_MANAGER',
])

export function isSecretPlaceholder(value: unknown): boolean {
  return SECRET_PLACEHOLDERS.has(String(value ?? '').trim().toUpperCase())
}

export function resolveSecretCandidate(configuredValue: unknown, fallbackValue: unknown): string {
  const configured = String(configuredValue ?? '').trim()
  const fallback = String(fallbackValue ?? '')
  return isSecretPlaceholder(configured) ? fallback : (configured || fallback)
}
