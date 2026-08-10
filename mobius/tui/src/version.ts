/**
 * The TUI package version has one source of truth: package.json.
 *
 * Keep all runtime/UI consumers behind this module so a release cannot show
 * a stale hard-coded version while the npm package has already been bumped.
 */
import { createRequire } from 'node:module'

interface TuiPackageMetadata {
  name?: string
  version?: string
}

const packageJson = createRequire(import.meta.url)('../package.json') as TuiPackageMetadata

if (!packageJson.version) {
  throw new Error('TUI package.json is missing a version')
}

export const TUI_VERSION = packageJson.version
export const TUI_PACKAGE_NAME = packageJson.name ?? '@mobius-os/mobius'
