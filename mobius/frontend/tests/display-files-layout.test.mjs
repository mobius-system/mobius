import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { chromium } from 'playwright'

const frontend = fileURLToPath(new URL('..', import.meta.url))
process.chdir(frontend)
const artifacts = process.env.DISPLAY_FILES_SCREENSHOTS || path.join(os.tmpdir(), 'display-files-layout')
await fs.mkdir(artifacts, { recursive: true })
const stylesheet = await postcss([tailwindcss({ config: path.join(frontend, 'tailwind.config.js') })])
  .process(await fs.readFile(path.join(frontend, 'src/index.css'), 'utf8'), { from: path.join(frontend, 'src/index.css') })
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { DisplayFilesCard } from './src/components/viewer/DisplayFiles'
      import { DisplayFileContext } from './src/components/viewer/DisplayFileContext'
      const files = [
        { path: '.trash/jev_demo/finetune/recursive_jev_paper/main.pdf' },
        { path: '.trash/jev_demo/finetune/recursive_jev_paper/main.tex' },
        { path: 'docs/paper_revision/pdf_update_20261102/README.md' },
        { path: 'src/' + 'long_directory_name/'.repeat(12) + 'example.ts', remote: 'dev', root: '/workspace' },
        { path: '../invalid.txt', remote: 'dev' },
      ]
      window.opened = []
      window.previews = []
      window.open = url => window.opened.push(url)
      window.addEventListener('mobius:request-open-file-in-sidebar', event => window.previews.push(event.detail))
      window.renderCards = easyMode => createRoot(document.getElementById('root')).render(
        <DisplayFileContext.Provider value={{ projectId: 'project', sessionId: 'session', bindPath: '/workspace' }}>
          <h1>{easyMode ? '精简模式' : '传统模式'} · 展示文件</h1>
          <DisplayFilesCard files={files} easyMode={easyMode} />
        </DisplayFileContext.Provider>
      )
    `,
    resolveDir: frontend,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'fixture-file-sizes',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const api = async () => ({ entries: [
        { name: 'main.pdf', type: 'file', size: 988877 },
        { name: 'main.tex', type: 'file', size: 3276 },
        { name: 'README.md', type: 'file', size: 1945 },
        { name: 'example.ts', type: 'file', size: 1024 }
      ] })` }))
    },
  }],
})
const browser = await chromium.launch({ headless: !process.env.DISPLAY })
try {
  for (const easyMode of [false, true]) {
    for (const width of [1000, 390]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser.newPage({ viewport: { width, height: 620 } })
        await page.route('http://display-files.test/**', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }))
        await page.goto('http://display-files.test/')
        await page.setContent(`<html class="${theme}"><head><meta charset="utf-8"><style>${stylesheet.css}
          body { padding: 20px; background: var(--bg-primary); color: var(--text-primary); }
          h1 { margin-bottom: 20px; font-size: 20px; }
        </style></head><body><main id="root"></main></body></html>`)
        await page.addScriptTag({ content: bundle.outputFiles[0].text })
        await page.evaluate(mode => window.renderCards(mode), easyMode)
        await page.getByText('965.7 KB', { exact: true }).waitFor()
        const rows = page.locator('.display-files-card__row')
        assert.equal(await rows.count(), 5)
        for (const row of await rows.all()) {
          const bounds = await row.boundingBox()
          assert(bounds.x >= 0 && bounds.x + bounds.width <= width)
          const item = row.locator('.display-files-card__item')
          const itemBounds = await item.boundingBox()
          assert(itemBounds.width > 100)
          const download = row.locator('.display-files-card__download')
          if (await download.count()) {
            const downloadBounds = await download.boundingBox()
            assert(Math.abs(downloadBounds.y - itemBounds.y) < 1)
            assert(Math.abs(downloadBounds.height - itemBounds.height) < 1)
            assert(downloadBounds.x >= itemBounds.x + itemBounds.width - 1)
            assert(downloadBounds.x + downloadBounds.width <= bounds.x + bounds.width)
            await download.click()
          }
        }
        assert.equal(await rows.nth(0).locator('.display-files-card__item').isDisabled(), true)
        assert.equal(await rows.nth(4).getByRole('button', { name: '下载文件', exact: true }).count(), 0)
        await rows.nth(2).locator('.display-files-card__item').click()
        const events = await page.evaluate(() => ({ downloads: window.opened, previews: window.previews }))
        assert.equal(events.downloads.length, 4)
        assert(events.downloads[0].startsWith('/api/download?path='))
        assert(events.downloads[3].includes('/remote-file/download?'))
        assert(events.downloads[3].includes('session=session'))
        assert.equal(events.previews.length, 1)
        assert.equal(events.previews[0].path, 'docs/paper_revision/pdf_update_20261102/README.md')
        await rows.nth(0).getByRole('button', { name: '下载文件', exact: true }).focus()
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '下载文件')
        await page.screenshot({ path: path.join(artifacts, `${easyMode ? 'easy' : 'traditional'}-${width}-${theme}.png`) })
        await page.close()
      }
    }
  }
  console.log(`Display file layout and independent preview/download actions pass in both modes, themes and widths. Screenshots: ${artifacts}`)
} finally {
  await browser.close()
}
