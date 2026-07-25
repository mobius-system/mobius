import { createElementSnapshot, elementBelowPoint, resolveSelection, targetRect } from './dom.js'
import { locateSource } from './locator-client.js'
import { buildAgentPrompt } from './prompt.js'

const ROOT_ATTRIBUTE = 'data-mobius-designer-eye-root'
const HOTKEY_LABEL = /Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘ + ⇧ + E' : 'Ctrl + Shift + E'

const SHELL_HTML = `
  <style>
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      pointer-events: none;
      color: #e5e7eb;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, textarea { font: inherit; }
    .shield {
      position: fixed;
      inset: 0;
      z-index: 1;
      pointer-events: auto;
      cursor: crosshair;
      background: transparent;
      touch-action: none;
    }
    .outline {
      position: fixed;
      z-index: 2;
      min-width: 4px;
      min-height: 4px;
      pointer-events: none;
      border: 2px solid #8b5cf6;
      border-radius: 4px;
      background: rgba(124, 58, 237, 0.09);
      box-shadow: 0 0 0 1px rgba(255,255,255,.72), 0 0 0 4px rgba(124,58,237,.16);
      transition: left 50ms linear, top 50ms linear, width 50ms linear, height 50ms linear;
    }
    .outline-label {
      position: absolute;
      left: -2px;
      bottom: calc(100% + 5px);
      max-width: min(360px, calc(100vw - 24px));
      padding: 3px 7px;
      overflow: hidden;
      border-radius: 5px;
      color: #fff;
      background: #6d28d9;
      box-shadow: 0 6px 20px rgba(76, 29, 149, .28);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      font-weight: 600;
      line-height: 16px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar {
      position: fixed;
      left: 50%;
      bottom: 72px;
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 32px);
      padding: 8px 12px;
      transform: translateX(-50%);
      pointer-events: auto;
      border: 1px solid rgba(167, 139, 250, .46);
      border-radius: 999px;
      color: #f5f3ff;
      background: rgba(30, 20, 50, .94);
      box-shadow: 0 14px 40px rgba(15, 8, 30, .4);
      backdrop-filter: blur(16px) saturate(1.15);
      -webkit-backdrop-filter: blur(16px) saturate(1.15);
      user-select: none;
    }
    .toolbar-dot {
      width: 8px;
      height: 8px;
      flex: none;
      border-radius: 50%;
      background: #a78bfa;
      box-shadow: 0 0 0 5px rgba(167, 139, 250, .14);
    }
    .toolbar-copy {
      overflow: hidden;
      font-size: 12px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-key {
      flex: none;
      color: #c4b5fd;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 10px;
    }
    .modal-layer {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 72px 24px 86px;
      pointer-events: auto;
      background: rgba(2, 6, 23, .62);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .modal {
      width: min(880px, 100%);
      max-height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, .28);
      border-radius: 16px;
      color: #e5e7eb;
      background: #0f172a;
      box-shadow: 0 28px 90px rgba(2, 6, 23, .62);
    }
    .modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px 15px;
      border-bottom: 1px solid rgba(148, 163, 184, .18);
    }
    .modal-title { margin: 0; color: #f8fafc; font-size: 17px; font-weight: 720; }
    .modal-subtitle { margin-top: 4px; color: #94a3b8; font-size: 12px; }
    .icon-button {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      border: 0;
      border-radius: 8px;
      color: #94a3b8;
      background: transparent;
      cursor: pointer;
    }
    .icon-button:hover { color: #f8fafc; background: rgba(148, 163, 184, .14); }
    .summary {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(260px, .75fr);
      gap: 12px;
      padding: 14px 20px 0;
    }
    .summary-card {
      min-width: 0;
      padding: 12px 14px;
      border: 1px solid rgba(148, 163, 184, .16);
      border-radius: 10px;
      background: rgba(30, 41, 59, .56);
    }
    .summary-label {
      margin-bottom: 5px;
      color: #94a3b8;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .summary-value {
      overflow: hidden;
      color: #e2e8f0;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      line-height: 17px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .locator-status {
      margin: 10px 20px 0;
      padding: 8px 11px;
      border-radius: 8px;
      color: #c4b5fd;
      background: rgba(109, 40, 217, .13);
      font-size: 11px;
    }
    .prompt-wrap {
      min-height: 0;
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 7px;
      padding: 12px 20px 16px;
    }
    .prompt-label { color: #cbd5e1; font-size: 12px; font-weight: 650; }
    .prompt {
      width: 100%;
      min-height: 260px;
      flex: 1;
      resize: none;
      border: 1px solid rgba(148, 163, 184, .22);
      border-radius: 10px;
      outline: none;
      padding: 13px 14px;
      color: #dbeafe;
      caret-color: #a78bfa;
      background: #020617;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      line-height: 1.65;
    }
    .prompt:focus { border-color: rgba(139, 92, 246, .85); box-shadow: 0 0 0 3px rgba(124, 58, 237, .15); }
    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 20px 16px;
      border-top: 1px solid rgba(148, 163, 184, .18);
    }
    .footer-note { color: #64748b; font-size: 10px; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .button {
      min-height: 34px;
      padding: 7px 13px;
      border: 1px solid rgba(148, 163, 184, .24);
      border-radius: 8px;
      color: #cbd5e1;
      background: rgba(30, 41, 59, .7);
      cursor: pointer;
      font-size: 12px;
      font-weight: 650;
    }
    .button:hover { color: #fff; border-color: rgba(167, 139, 250, .5); background: rgba(51, 65, 85, .86); }
    .button-primary { border-color: #7c3aed; color: #fff; background: #7c3aed; }
    .button-primary:hover { border-color: #8b5cf6; background: #8b5cf6; }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 20;
      padding: 8px 13px;
      transform: translateX(-50%);
      pointer-events: none;
      border-radius: 999px;
      color: #ecfdf5;
      background: rgba(5, 150, 105, .95);
      box-shadow: 0 10px 30px rgba(6, 78, 59, .32);
      font-size: 11px;
      font-weight: 700;
    }
    @media (max-width: 700px) {
      .toolbar { bottom: 22px; }
      .modal-layer { padding: 24px 12px; }
      .summary { grid-template-columns: 1fr; }
      .modal-footer { align-items: stretch; flex-direction: column; }
      .actions { justify-content: stretch; }
      .actions .button { flex: 1; }
      .footer-note { text-align: center; }
    }
  </style>
  <div class="shield" data-eye="shield" hidden></div>
  <div class="outline" data-eye="outline" hidden><div class="outline-label" data-eye="outline-label"></div></div>
  <div class="toolbar" data-eye="toolbar" hidden>
    <span class="toolbar-dot"></span>
    <span class="toolbar-copy">设计师之眼已开启 · 点击选择元素 · Alt/Option 精确选择 · Esc 退出</span>
    <span class="toolbar-key"></span>
  </div>
  <div class="modal-layer" data-eye="modal-layer" hidden>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="designer-eye-title">
      <header class="modal-header">
        <div>
          <h2 class="modal-title" id="designer-eye-title">设计师之眼</h2>
          <div class="modal-subtitle">已阻止原元素交互，并生成可交给 Agent 的源码定位提示词</div>
        </div>
        <button type="button" class="icon-button" data-eye="close" aria-label="关闭并重新选择" title="关闭并重新选择">✕</button>
      </header>
      <div class="summary">
        <div class="summary-card">
          <div class="summary-label">选中元素</div>
          <div class="summary-value" data-eye="element-summary"></div>
        </div>
        <div class="summary-card">
          <div class="summary-label">页面</div>
          <div class="summary-value" data-eye="page-summary"></div>
        </div>
      </div>
      <div class="locator-status" data-eye="locator-status">正在定位源码候选…</div>
      <div class="prompt-wrap">
        <label class="prompt-label" for="designer-eye-prompt">Agent 提示词（可编辑）</label>
        <textarea class="prompt" id="designer-eye-prompt" data-eye="prompt" spellcheck="false"></textarea>
      </div>
      <footer class="modal-footer">
        <div class="footer-note">不会上传页面截图、输入框值或凭据；复制前可继续编辑。</div>
        <div class="actions">
          <button type="button" class="button" data-eye="exit">退出模式</button>
          <button type="button" class="button" data-eye="reselect">重新选择</button>
          <button type="button" class="button button-primary" data-eye="copy">复制提示词</button>
        </div>
      </footer>
    </section>
  </div>
  <div class="toast" data-eye="toast" hidden></div>
`

function isToggleHotkey(event) {
  return event.key?.toLowerCase() === 'e'
    && event.shiftKey
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
}

function scrollContainerFor(element) {
  let current = element
  while (current && current !== document.body) {
    const style = getComputedStyle(current)
    const canScrollY = /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight
    const canScrollX = /(auto|scroll)/.test(style.overflowX) && current.scrollWidth > current.clientWidth
    if (canScrollY || canScrollX) return current
    current = current.parentElement
  }
  return document.scrollingElement || document.documentElement
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const helper = document.createElement('textarea')
  helper.value = text
  helper.setAttribute('readonly', '')
  helper.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(helper)
  helper.select()
  const ok = document.execCommand('copy')
  helper.remove()
  if (!ok) throw new Error('浏览器拒绝复制')
}

export class DesignerEyeRuntime {
  constructor() {
    this.active = false
    this.modalOpen = false
    this.host = null
    this.shadow = null
    this.hoveredElement = null
    this.selectedElement = null
    this.pointerDownElement = null
    this.snapshot = null
    this.generatedPrompt = ''
    this.raf = 0
    this.toastTimer = 0

    this.onGlobalKeyDown = this.onGlobalKeyDown.bind(this)
    this.onPointerMove = this.onPointerMove.bind(this)
    this.onPointerDown = this.onPointerDown.bind(this)
    this.onPointerUp = this.onPointerUp.bind(this)
    this.onWheel = this.onWheel.bind(this)
    this.refreshSelectedOutline = this.refreshSelectedOutline.bind(this)
  }

  install() {
    window.addEventListener('keydown', this.onGlobalKeyDown, true)
  }

  ensureShell() {
    if (this.host?.isConnected) return
    const existing = document.querySelector(`[${ROOT_ATTRIBUTE}]`)
    if (existing) existing.remove()

    this.host = document.createElement('div')
    this.host.setAttribute(ROOT_ATTRIBUTE, '')
    this.host.setAttribute('aria-hidden', 'true')
    this.shadow = this.host.attachShadow({ mode: 'open' })
    this.shadow.innerHTML = SHELL_HTML
    document.documentElement.appendChild(this.host)

    this.elements = {
      shield: this.shadow.querySelector('[data-eye="shield"]'),
      outline: this.shadow.querySelector('[data-eye="outline"]'),
      outlineLabel: this.shadow.querySelector('[data-eye="outline-label"]'),
      toolbar: this.shadow.querySelector('[data-eye="toolbar"]'),
      toolbarKey: this.shadow.querySelector('.toolbar-key'),
      modalLayer: this.shadow.querySelector('[data-eye="modal-layer"]'),
      elementSummary: this.shadow.querySelector('[data-eye="element-summary"]'),
      pageSummary: this.shadow.querySelector('[data-eye="page-summary"]'),
      locatorStatus: this.shadow.querySelector('[data-eye="locator-status"]'),
      prompt: this.shadow.querySelector('[data-eye="prompt"]'),
      toast: this.shadow.querySelector('[data-eye="toast"]'),
    }
    this.elements.toolbarKey.textContent = HOTKEY_LABEL

    this.elements.shield.addEventListener('pointermove', this.onPointerMove)
    this.elements.shield.addEventListener('pointerdown', this.onPointerDown)
    this.elements.shield.addEventListener('pointerup', this.onPointerUp)
    this.elements.shield.addEventListener('pointercancel', () => { this.pointerDownElement = null })
    this.elements.shield.addEventListener('click', event => event.preventDefault())
    this.elements.shield.addEventListener('dblclick', event => event.preventDefault())
    this.elements.shield.addEventListener('contextmenu', event => event.preventDefault())
    this.elements.shield.addEventListener('dragstart', event => event.preventDefault())
    this.elements.shield.addEventListener('wheel', this.onWheel, { passive: false })

    this.shadow.querySelector('[data-eye="close"]').addEventListener('click', () => this.resumeSelection())
    this.shadow.querySelector('[data-eye="reselect"]').addEventListener('click', () => this.resumeSelection())
    this.shadow.querySelector('[data-eye="exit"]').addEventListener('click', () => this.deactivate())
    this.shadow.querySelector('[data-eye="copy"]').addEventListener('click', async () => {
      try {
        await copyText(this.elements.prompt.value)
        this.showToast('提示词已复制')
      } catch (error) {
        this.showToast(error?.message || '复制失败', true)
      }
    })
  }

  onGlobalKeyDown(event) {
    if (isToggleHotkey(event)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat) return
      if (this.active) this.deactivate()
      else this.activate()
      return
    }
    if (!this.active || event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (this.modalOpen) this.resumeSelection()
    else this.deactivate()
  }

  activate() {
    this.ensureShell()
    this.active = true
    this.modalOpen = false
    this.host.setAttribute('aria-hidden', 'false')
    this.elements.shield.hidden = false
    this.elements.toolbar.hidden = false
    this.elements.modalLayer.hidden = true
    this.elements.outline.hidden = true
    this.hoveredElement = null
    this.selectedElement = null
    document.documentElement.setAttribute('data-designer-eye-active', '')
  }

  deactivate() {
    if (!this.host) return
    this.active = false
    this.modalOpen = false
    this.hoveredElement = null
    this.selectedElement = null
    this.pointerDownElement = null
    this.snapshot = null
    cancelAnimationFrame(this.raf)
    this.elements.shield.hidden = true
    this.elements.toolbar.hidden = true
    this.elements.modalLayer.hidden = true
    this.elements.outline.hidden = true
    this.host.setAttribute('aria-hidden', 'true')
    document.documentElement.removeAttribute('data-designer-eye-active')
    window.removeEventListener('scroll', this.refreshSelectedOutline, true)
    window.removeEventListener('resize', this.refreshSelectedOutline)
  }

  elementAtEvent(event) {
    return elementBelowPoint(event.clientX, event.clientY, this.host)
  }

  onPointerMove(event) {
    if (!this.active || this.modalOpen) return
    const exact = this.elementAtEvent(event)
    if (!exact) {
      this.elements.outline.hidden = true
      this.hoveredElement = null
      return
    }
    const selection = resolveSelection(exact, event.altKey)
    this.hoveredElement = selection.semantic
    this.drawOutline(selection.semantic, selection.exact)
  }

  onPointerDown(event) {
    if (event.button !== 0) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    this.pointerDownElement = this.elementAtEvent(event)
    try { this.elements.shield.setPointerCapture(event.pointerId) } catch { /* noop */ }
  }

  onPointerUp(event) {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0) return
    const exact = this.pointerDownElement || this.elementAtEvent(event)
    this.pointerDownElement = null
    if (!exact) return
    const selection = resolveSelection(exact, event.altKey)
    this.openSelection(selection)
  }

  onWheel(event) {
    if (!this.active || this.modalOpen) return
    event.preventDefault()
    const exact = this.elementAtEvent(event)
    const scroller = scrollContainerFor(exact)
    if (scroller === document.documentElement || scroller === document.body || scroller === document.scrollingElement) {
      window.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'auto' })
    } else {
      scroller.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'auto' })
    }
    requestAnimationFrame(() => {
      const next = this.elementAtEvent(event)
      if (next) {
        const selection = resolveSelection(next, event.altKey)
        this.hoveredElement = selection.semantic
        this.drawOutline(selection.semantic, selection.exact)
      }
    })
  }

  drawOutline(element, exact = element) {
    if (!element?.isConnected) {
      this.elements.outline.hidden = true
      return
    }
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => {
      const rect = targetRect(element)
      this.elements.outline.style.left = `${Math.round(rect.left)}px`
      this.elements.outline.style.top = `${Math.round(rect.top)}px`
      this.elements.outline.style.width = `${Math.max(4, Math.round(rect.width))}px`
      this.elements.outline.style.height = `${Math.max(4, Math.round(rect.height))}px`
      const suffix = exact !== element ? ` · 命中 ${exact.tagName.toLowerCase()}` : ''
      this.elements.outlineLabel.textContent = `${element.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}${suffix}`
      this.elements.outline.hidden = false
    })
  }

  refreshSelectedOutline() {
    if (this.active && this.selectedElement?.isConnected) this.drawOutline(this.selectedElement)
  }

  openSelection(selection) {
    this.selectedElement = selection.semantic
    this.snapshot = createElementSnapshot(selection)
    this.modalOpen = true
    this.drawOutline(selection.semantic, selection.exact)
    this.elements.shield.hidden = true
    this.elements.modalLayer.hidden = false
    this.elements.elementSummary.textContent = `${this.snapshot.element.selector || this.snapshot.element.tag} · ${this.snapshot.element.style.rect.width}×${this.snapshot.element.style.rect.height}`
    this.elements.pageSummary.textContent = this.snapshot.page.path
    this.elements.locatorStatus.textContent = '正在定位源码候选…'
    this.generatedPrompt = buildAgentPrompt(this.snapshot)
    this.elements.prompt.value = this.generatedPrompt
    window.addEventListener('scroll', this.refreshSelectedOutline, true)
    window.addEventListener('resize', this.refreshSelectedOutline)

    locateSource(this.snapshot).then(result => {
      if (!this.modalOpen || !this.snapshot) return
      const previousGenerated = this.generatedPrompt
      this.generatedPrompt = buildAgentPrompt(this.snapshot, result)
      if (this.elements.prompt.value === previousGenerated) this.elements.prompt.value = this.generatedPrompt
      if (result.candidates?.length) {
        const first = result.candidates[0]
        this.elements.locatorStatus.textContent = `已找到 ${result.candidates.length} 个候选；最高匹配 ${first.file}:${first.line}`
      } else {
        this.elements.locatorStatus.textContent = result.unavailable || '未找到直接候选，提示词已包含本地检索线索。'
      }
    }).catch(() => {
      if (this.modalOpen) this.elements.locatorStatus.textContent = '源码定位暂不可用，提示词已包含本地检索线索。'
    })
  }

  resumeSelection() {
    if (!this.active) return
    this.modalOpen = false
    this.elements.modalLayer.hidden = true
    this.elements.shield.hidden = false
    window.removeEventListener('scroll', this.refreshSelectedOutline, true)
    window.removeEventListener('resize', this.refreshSelectedOutline)
    if (!this.selectedElement?.isConnected) this.elements.outline.hidden = true
  }

  showToast(message, error = false) {
    window.clearTimeout(this.toastTimer)
    this.elements.toast.textContent = message
    this.elements.toast.style.background = error ? 'rgba(190, 24, 93, .96)' : 'rgba(5, 150, 105, .95)'
    this.elements.toast.hidden = false
    this.toastTimer = window.setTimeout(() => { this.elements.toast.hidden = true }, 1800)
  }
}
