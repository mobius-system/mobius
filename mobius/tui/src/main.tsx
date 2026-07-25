/**
 * Mobius terminal entry point.
 *
 * Run:  npx tsx src/main.tsx   (or `npm start`)
 *
 * exitOnCtrlC is disabled — the composer interprets Ctrl+C itself (stop the
 * current generation while busy; quit when idle). Use /quit to exit explicitly.
 */
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'

render(React.createElement(App), { exitOnCtrlC: false })
