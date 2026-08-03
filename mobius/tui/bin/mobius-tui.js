#!/usr/bin/env node
// bin/mobius-tui.js — launch the Mobius TUI via tsx (no build step required).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const tsx = join(here, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const entry = join(here, '..', 'src', 'main.tsx')

const result = spawnSync(tsx, [entry], { stdio: 'inherit' })
process.exit(result.status ?? 0)
