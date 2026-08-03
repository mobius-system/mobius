/**
 * Mobius terminal entry point.
 *
 * Run:  npx tsx src/main.tsx   (or `npm start`)
 *
 * Ink owns Ctrl+C globally so Windows users can always exit, including from
 * setup screens that do not mount the chat composer.
 */
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'

render(React.createElement(App), { exitOnCtrlC: true })
