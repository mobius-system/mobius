import { createElementSnapshot, elementBelowPoint, resolveSelection, targetRect } from './dom.js'
import { locateSource } from './locator-client.js'
import { buildAgentPrompt, replacePromptRequirement } from './prompt.js'
import {
  createAndStartSelfIteration,
  loadIssueContext,
  loadProjectIssues,
  loadSelfIterationBootstrap,
} from './self-iteration-client.js'

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
    button, input, select, textarea { font: inherit; }
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
    .outline-selected {
      border-color: #10b981;
      background: rgba(16, 185, 129, .09);
      box-shadow: 0 0 0 1px rgba(255,255,255,.72), 0 0 0 4px rgba(16, 185, 129, .16);
    }
    .outline-selected .outline-label { background: #047857; }
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
      width: min(1040px, 100%);
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
    .modal-content { min-height: 0; overflow-y: auto; }
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
      color: #e2e8f0;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      line-height: 17px;
    }
    .selection-list {
      display: flex;
      max-height: 106px;
      flex-direction: column;
      gap: 5px;
      overflow-y: auto;
    }
    .selection-row {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 7px;
      align-items: center;
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(15, 23, 42, .62);
    }
    .selection-index { color: #6ee7b7; font-weight: 750; }
    .selection-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selection-remove {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 5px;
      color: #94a3b8;
      background: transparent;
      cursor: pointer;
    }
    .selection-remove:hover { color: #fda4af; background: rgba(244, 63, 94, .12); }
    .page-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .locator-status {
      margin: 10px 20px 0;
      padding: 8px 11px;
      border-radius: 8px;
      color: #c4b5fd;
      background: rgba(109, 40, 217, .13);
      font-size: 11px;
    }
    .iteration-form {
      display: flex;
      flex-direction: column;
      gap: 11px;
      padding: 12px 20px 0;
    }
    .requirement {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      border: 1px solid rgba(148, 163, 184, .22);
      border-radius: 10px;
      outline: none;
      padding: 10px 12px;
      color: #f8fafc;
      background: rgba(2, 6, 23, .84);
      font-size: 12px;
      line-height: 1.55;
    }
    .requirement:focus, .select:focus { border-color: rgba(139, 92, 246, .85); box-shadow: 0 0 0 3px rgba(124, 58, 237, .13); }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .config-grid-secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field { min-width: 0; }
    .field-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 650;
    }
    .field-hint { color: #64748b; font-size: 9px; font-weight: 500; }
    .select, .picker-summary {
      width: 100%;
      min-height: 36px;
      border: 1px solid rgba(148, 163, 184, .22);
      border-radius: 8px;
      color: #e2e8f0;
      background: #111c31;
      font-size: 11px;
    }
    .select { padding: 0 9px; outline: none; }
    .select:disabled { cursor: wait; opacity: .55; }
    .multi-picker { position: relative; }
    .multi-picker > summary { list-style: none; }
    .multi-picker > summary::-webkit-details-marker { display: none; }
    .picker-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .picker-summary::after { content: '⌄'; color: #94a3b8; font-size: 12px; }
    .multi-picker[open] .picker-summary::after { content: '⌃'; }
    .picker-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 5px);
      z-index: 8;
      max-height: 250px;
      overflow-y: auto;
      padding: 6px;
      border: 1px solid rgba(148, 163, 184, .28);
      border-radius: 10px;
      background: #111827;
      box-shadow: 0 18px 46px rgba(2, 6, 23, .65);
    }
    .picker-item {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 7px 8px;
      border-radius: 7px;
      cursor: pointer;
    }
    .picker-item:hover { background: rgba(99, 102, 241, .13); }
    .picker-item input { margin: 2px 0 0; accent-color: #8b5cf6; }
    .picker-item-name { display: block; overflow: hidden; color: #e5e7eb; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .picker-item-desc { display: block; margin-top: 2px; overflow: hidden; color: #64748b; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
    .form-status {
      min-height: 16px;
      color: #94a3b8;
      font-size: 10px;
    }
    .form-status[data-error="true"] { color: #fda4af; }
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
      min-height: 210px;
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
    .button:disabled { cursor: wait; opacity: .55; }
    .button-primary { border-color: #7c3aed; color: #fff; background: #7c3aed; }
    .button-primary:hover { border-color: #8b5cf6; background: #8b5cf6; }
    .button-start { border-color: #059669; color: #fff; background: #059669; }
    .button-start:hover { border-color: #10b981; background: #10b981; }
    .confirm-layer {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      pointer-events: auto;
      background: rgba(2, 6, 23, .74);
      backdrop-filter: blur(6px);
    }
    .confirm-card {
      width: min(460px, 100%);
      padding: 20px;
      border: 1px solid rgba(52, 211, 153, .3);
      border-radius: 14px;
      background: #0f172a;
      box-shadow: 0 28px 90px rgba(2, 6, 23, .7);
    }
    .confirm-title { margin: 0; color: #ecfdf5; font-size: 16px; font-weight: 720; }
    .confirm-copy { margin: 8px 0 16px; color: #94a3b8; font-size: 12px; line-height: 1.6; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
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
      .config-grid, .config-grid-secondary { grid-template-columns: 1fr; }
      .modal-footer { align-items: stretch; flex-direction: column; }
      .actions { justify-content: stretch; }
      .actions .button { flex: 1; }
      .footer-note { text-align: center; }
    }
  </style>
  <div class="shield" data-eye="shield" hidden></div>
  <div data-eye="selection-outlines"></div>
  <div class="outline" data-eye="outline" hidden><div class="outline-label" data-eye="outline-label"></div></div>
  <div class="toolbar" data-eye="toolbar" hidden>
    <span class="toolbar-dot"></span>
    <span class="toolbar-copy" data-eye="toolbar-copy">设计师之眼已开启 · 点击选择元素 · Alt/Option 精确选择 · Esc 退出</span>
    <span class="toolbar-key"></span>
  </div>
  <div class="modal-layer" data-eye="modal-layer" hidden>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="designer-eye-title">
      <header class="modal-header">
        <div>
          <h2 class="modal-title" id="designer-eye-title">设计师之眼</h2>
          <div class="modal-subtitle" data-eye="modal-subtitle">已阻止原元素交互，并生成可交给 Agent 的源码定位提示词</div>
        </div>
        <button type="button" class="icon-button" data-eye="close" aria-label="继续添加元素" title="继续添加元素">✕</button>
      </header>
      <div class="modal-content">
      <div class="summary">
        <div class="summary-card">
          <div class="summary-label">已选元素（按点击顺序）</div>
          <div class="summary-value selection-list" data-eye="element-summary"></div>
        </div>
        <div class="summary-card">
          <div class="summary-label">页面</div>
          <div class="summary-value page-value" data-eye="page-summary"></div>
        </div>
      </div>
      <div class="locator-status" data-eye="locator-status">正在定位源码候选…</div>
      <div class="iteration-form">
        <div class="field">
          <label class="field-label" for="designer-eye-requirement">修改要求 <span class="field-hint">会实时写入下方提示词</span></label>
          <textarea class="requirement" id="designer-eye-requirement" data-eye="requirement" placeholder="请在这里输入改进要求，例如：减小按钮高度，并让主次操作层级更清晰。"></textarea>
        </div>
        <div class="config-grid">
          <div class="field">
            <label class="field-label" for="designer-eye-project">Mobius 项目</label>
            <select class="select" id="designer-eye-project" data-eye="project"><option value="">正在加载自进化项目…</option></select>
          </div>
          <div class="field">
            <label class="field-label" for="designer-eye-issue">Mobius Issue</label>
            <select class="select" id="designer-eye-issue" data-eye="issue"><option value="">请先选择项目</option></select>
          </div>
          <div class="field">
            <label class="field-label" for="designer-eye-model">模型</label>
            <select class="select" id="designer-eye-model" data-eye="model"><option value="">正在加载模型…</option></select>
          </div>
        </div>
        <div class="config-grid config-grid-secondary">
          <div class="field">
            <div class="field-label">Skill <span class="field-hint">取消勾选 = 不注入</span></div>
            <details class="multi-picker" data-eye="skill-picker">
              <summary class="picker-summary"><span>Skill</span><span data-eye="skill-count">选择 Issue 后加载</span></summary>
              <div class="picker-menu" data-eye="skill-menu"></div>
            </details>
          </div>
          <div class="field">
            <div class="field-label">Memory <span class="field-hint">取消勾选 = 不注入</span></div>
            <details class="multi-picker" data-eye="memory-picker">
              <summary class="picker-summary"><span>Memory</span><span data-eye="memory-count">选择 Issue 后加载</span></summary>
              <div class="picker-menu" data-eye="memory-menu"></div>
            </details>
          </div>
        </div>
        <div class="form-status" data-eye="form-status">正在准备自进化会话选项…</div>
      </div>
      <div class="prompt-wrap">
        <label class="prompt-label" for="designer-eye-prompt">Agent 提示词（可编辑）</label>
        <textarea class="prompt" id="designer-eye-prompt" data-eye="prompt" spellcheck="false"></textarea>
      </div>
      </div>
      <footer class="modal-footer">
        <div class="footer-note">不会上传页面截图、输入框值或凭据；复制前可继续编辑。</div>
        <div class="actions">
          <button type="button" class="button" data-eye="exit">退出模式</button>
          <button type="button" class="button" data-eye="clear-reselect">清空重选</button>
          <button type="button" class="button" data-eye="continue">继续添加元素</button>
          <button type="button" class="button button-primary" data-eye="copy">复制提示词</button>
          <button type="button" class="button button-start" data-eye="start">启动自进化</button>
        </div>
      </footer>
    </section>
  </div>
  <div class="confirm-layer" data-eye="confirm-layer" hidden>
    <section class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="designer-eye-confirm-title">
      <h3 class="confirm-title" id="designer-eye-confirm-title" data-eye="confirm-title">自进化会话已创建并启动</h3>
      <p class="confirm-copy" data-eye="confirm-copy">Agent 已开始处理。是否现在进入该会话查看进度？</p>
      <div class="confirm-actions">
        <button type="button" class="button" data-eye="stay">留在当前页面</button>
        <button type="button" class="button button-start" data-eye="go-session">进入新会话</button>
      </div>
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
    this.selections = []
    this.pointerDownElement = null
    this.generatedPrompt = ''
    this.raf = 0
    this.toastTimer = 0
    this.bootstrapPromise = null
    this.startingSelfIteration = false
    this.lastCreatedSession = null
    this.selfIteration = {
      loaded: false,
      projects: [],
      issues: [],
      models: [],
      skills: [],
      memories: [],
      selectedSkillIds: new Set(),
      selectedMemoryIds: new Set(),
      projectId: '',
      issueId: '',
      model: '',
      modelTouched: false,
      globalDefaultModel: '',
      userId: '',
      route: { projectId: '', issueId: '' },
      issueRequestVersion: 0,
      contextRequestVersion: 0,
    }

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
      selectionOutlines: this.shadow.querySelector('[data-eye="selection-outlines"]'),
      outline: this.shadow.querySelector('[data-eye="outline"]'),
      outlineLabel: this.shadow.querySelector('[data-eye="outline-label"]'),
      toolbar: this.shadow.querySelector('[data-eye="toolbar"]'),
      toolbarCopy: this.shadow.querySelector('[data-eye="toolbar-copy"]'),
      toolbarKey: this.shadow.querySelector('.toolbar-key'),
      modalLayer: this.shadow.querySelector('[data-eye="modal-layer"]'),
      modalSubtitle: this.shadow.querySelector('[data-eye="modal-subtitle"]'),
      elementSummary: this.shadow.querySelector('[data-eye="element-summary"]'),
      pageSummary: this.shadow.querySelector('[data-eye="page-summary"]'),
      locatorStatus: this.shadow.querySelector('[data-eye="locator-status"]'),
      requirement: this.shadow.querySelector('[data-eye="requirement"]'),
      project: this.shadow.querySelector('[data-eye="project"]'),
      issue: this.shadow.querySelector('[data-eye="issue"]'),
      model: this.shadow.querySelector('[data-eye="model"]'),
      skillPicker: this.shadow.querySelector('[data-eye="skill-picker"]'),
      memoryPicker: this.shadow.querySelector('[data-eye="memory-picker"]'),
      skillMenu: this.shadow.querySelector('[data-eye="skill-menu"]'),
      memoryMenu: this.shadow.querySelector('[data-eye="memory-menu"]'),
      skillCount: this.shadow.querySelector('[data-eye="skill-count"]'),
      memoryCount: this.shadow.querySelector('[data-eye="memory-count"]'),
      formStatus: this.shadow.querySelector('[data-eye="form-status"]'),
      prompt: this.shadow.querySelector('[data-eye="prompt"]'),
      start: this.shadow.querySelector('[data-eye="start"]'),
      confirmLayer: this.shadow.querySelector('[data-eye="confirm-layer"]'),
      confirmTitle: this.shadow.querySelector('[data-eye="confirm-title"]'),
      confirmCopy: this.shadow.querySelector('[data-eye="confirm-copy"]'),
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
    this.shadow.querySelector('[data-eye="continue"]').addEventListener('click', () => this.resumeSelection())
    this.shadow.querySelector('[data-eye="clear-reselect"]').addEventListener('click', () => this.clearSelectionsAndResume())
    this.shadow.querySelector('[data-eye="exit"]').addEventListener('click', () => this.deactivate())
    this.elements.requirement.addEventListener('input', () => this.refreshGeneratedPrompt(true))
    this.elements.project.addEventListener('change', () => {
      this.selfIteration.projectId = this.elements.project.value
      this.selfIteration.issueId = ''
      this.selfIteration.modelTouched = false
      this.selfIteration.model = this.resolveModelDefault()
      this.loadIssuesForProject(this.selfIteration.projectId)
    })
    this.elements.issue.addEventListener('change', () => {
      this.selfIteration.issueId = this.elements.issue.value
      this.selfIteration.modelTouched = false
      this.loadContextForIssue(this.selfIteration.issueId)
    })
    this.elements.model.addEventListener('change', () => {
      this.selfIteration.model = this.elements.model.value
      this.selfIteration.modelTouched = true
    })
    this.elements.start.addEventListener('click', () => this.startSelfIteration())
    this.shadow.querySelector('[data-eye="stay"]').addEventListener('click', () => {
      this.elements.confirmLayer.hidden = true
      this.showToast('自进化会话已在后台运行')
    })
    this.shadow.querySelector('[data-eye="go-session"]').addEventListener('click', () => {
      if (this.lastCreatedSession?.detailUrl) window.location.assign(this.lastCreatedSession.detailUrl)
    })
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
    this.selections = []
    this.renderSelectedOutlines()
    this.updateToolbar()
    document.documentElement.setAttribute('data-designer-eye-active', '')
  }

  deactivate() {
    if (!this.host) return
    this.active = false
    this.modalOpen = false
    this.hoveredElement = null
    this.selectedElement = null
    this.selections = []
    this.pointerDownElement = null
    this.lastCreatedSession = null
    cancelAnimationFrame(this.raf)
    this.elements.shield.hidden = true
    this.elements.toolbar.hidden = true
    this.elements.modalLayer.hidden = true
    this.elements.confirmLayer.hidden = true
    this.elements.outline.hidden = true
    this.renderSelectedOutlines()
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
    if (!this.active) return
    this.renderSelectedOutlines()
    if (this.modalOpen && this.selectedElement?.isConnected) this.drawOutline(this.selectedElement)
  }

  updateToolbar() {
    if (!this.elements?.toolbarCopy) return
    const count = this.selections.length
    this.elements.toolbarCopy.textContent = count
      ? `已选择 ${count} 个元素 · 点击继续添加 · Alt/Option 精确选择 · Esc ${this.modalOpen ? '继续选择' : '退出'}`
      : '设计师之眼已开启 · 点击选择元素 · Alt/Option 精确选择 · Esc 退出'
  }

  renderSelectedOutlines() {
    if (!this.elements?.selectionOutlines) return
    this.elements.selectionOutlines.replaceChildren()
    for (const [index, entry] of this.selections.entries()) {
      if (!entry.element?.isConnected) continue
      const rect = targetRect(entry.element)
      const outline = document.createElement('div')
      outline.className = 'outline outline-selected'
      outline.style.left = `${Math.round(rect.left)}px`
      outline.style.top = `${Math.round(rect.top)}px`
      outline.style.width = `${Math.max(4, Math.round(rect.width))}px`
      outline.style.height = `${Math.max(4, Math.round(rect.height))}px`
      const label = document.createElement('div')
      label.className = 'outline-label'
      label.textContent = `元素${index + 1}`
      outline.appendChild(label)
      this.elements.selectionOutlines.appendChild(outline)
    }
  }

  renderSelectionSummary() {
    this.elements.elementSummary.replaceChildren()
    for (const [index, entry] of this.selections.entries()) {
      const row = document.createElement('div')
      row.className = 'selection-row'
      const number = document.createElement('span')
      number.className = 'selection-index'
      number.textContent = `元素${index + 1}`
      const name = document.createElement('span')
      name.className = 'selection-name'
      name.textContent = `${entry.snapshot.element.selector || entry.snapshot.element.tag} · ${entry.snapshot.element.style.rect.width}×${entry.snapshot.element.style.rect.height}`
      name.title = name.textContent
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'selection-remove'
      remove.textContent = '✕'
      remove.title = `移除元素${index + 1}`
      remove.setAttribute('aria-label', `移除元素${index + 1}`)
      remove.addEventListener('click', () => this.removeSelection(entry))
      row.append(number, name, remove)
      this.elements.elementSummary.appendChild(row)
    }
    this.elements.modalSubtitle.textContent = `已按点击顺序选择 ${this.selections.length} 个元素；可继续添加或移除后重新编号`
  }

  updateLocatorStatus() {
    if (!this.selections.length) {
      this.elements.locatorStatus.textContent = '尚未选择元素。'
      return
    }
    const locating = this.selections.filter(entry => entry.locating).length
    if (locating) {
      this.elements.locatorStatus.textContent = `正在定位源码候选…（剩余 ${locating}/${this.selections.length} 个元素）`
      return
    }
    const candidateCount = this.selections.reduce((total, entry) => total + (entry.locationResult?.candidates?.length || 0), 0)
    const unavailableCount = this.selections.filter(entry => !entry.locationResult?.candidates?.length).length
    this.elements.locatorStatus.textContent = candidateCount
      ? `已为 ${this.selections.length} 个元素找到 ${candidateCount} 个源码候选${unavailableCount ? `；${unavailableCount} 个元素使用本地 DOM 线索` : ''}`
      : '未找到直接候选，提示词已为每个元素包含本地检索线索。'
  }

  removeSelection(entry) {
    const index = this.selections.indexOf(entry)
    if (index < 0) return
    this.selections.splice(index, 1)
    this.selectedElement = this.selections.at(-1)?.element || null
    if (!this.selections.length) {
      this.clearSelectionsAndResume()
      return
    }
    this.renderSelectionSummary()
    this.renderSelectedOutlines()
    this.updateLocatorStatus()
    this.updateToolbar()
    this.refreshGeneratedPrompt(false, true)
  }

  setFormStatus(message, error = false) {
    this.elements.formStatus.textContent = message || ''
    this.elements.formStatus.dataset.error = error ? 'true' : 'false'
  }

  setSelectOptions(select, options, { placeholder = '', value = '', disabled = false } = {}) {
    select.replaceChildren()
    if (placeholder) {
      const item = document.createElement('option')
      item.value = ''
      item.textContent = placeholder
      select.appendChild(item)
    }
    for (const option of options) {
      const item = document.createElement('option')
      item.value = String(option.value)
      item.textContent = String(option.label)
      select.appendChild(item)
    }
    select.disabled = disabled
    select.value = options.some(option => String(option.value) === String(value)) ? String(value) : ''
  }

  selectedProject() {
    return this.selfIteration.projects.find(project => String(project.id) === String(this.selfIteration.projectId)) || null
  }

  selectedIssue() {
    return this.selfIteration.issues.find(issue => String(issue.id) === String(this.selfIteration.issueId)) || null
  }

  resolveModelDefault(scopeModel = '') {
    const project = this.selectedProject()
    const candidates = [scopeModel, project?.default_model, this.selfIteration.globalDefaultModel, 'codex', this.selfIteration.models[0]?.key]
    return String(candidates.find(key => key && this.selfIteration.models.some(model => model.key === key)) || '')
  }

  renderSelects() {
    this.setSelectOptions(this.elements.project, this.selfIteration.projects.map(project => ({
      value: project.id,
      label: project.name,
    })), {
      placeholder: this.selfIteration.projects.length ? '— 选择 Mobius 自进化项目 —' : '未找到 Mobius 自进化项目',
      value: this.selfIteration.projectId,
      disabled: !this.selfIteration.loaded,
    })
    this.setSelectOptions(this.elements.issue, this.selfIteration.issues.map(issue => ({
      value: issue.id,
      label: issue.title,
    })), {
      placeholder: this.selfIteration.projectId ? (this.selfIteration.issues.length ? '— 选择 Mobius Issue —' : '该项目暂无开放 Issue') : '请先选择项目',
      value: this.selfIteration.issueId,
      disabled: !this.selfIteration.projectId,
    })
    this.setSelectOptions(this.elements.model, this.selfIteration.models.map(model => ({
      value: model.key,
      label: model.sub ? `${model.title} · ${model.sub}` : model.title,
    })), {
      placeholder: this.selfIteration.models.length ? '— 选择模型 —' : '暂无可用模型',
      value: this.selfIteration.model,
      disabled: !this.selfIteration.models.length,
    })
  }

  renderPicker(kind) {
    const isSkill = kind === 'skill'
    const items = isSkill ? this.selfIteration.skills : this.selfIteration.memories
    const selected = isSkill ? this.selfIteration.selectedSkillIds : this.selfIteration.selectedMemoryIds
    const menu = isSkill ? this.elements.skillMenu : this.elements.memoryMenu
    const count = isSkill ? this.elements.skillCount : this.elements.memoryCount
    menu.replaceChildren()
    count.textContent = `${selected.size}/${items.length} 已启用`
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'picker-item-desc'
      empty.style.padding = '12px 8px'
      empty.textContent = this.selfIteration.issueId ? `无可用 ${isSkill ? 'Skill' : 'Memory'}` : '选择 Issue 后加载'
      menu.appendChild(empty)
      return
    }
    for (const item of items) {
      const locked = isSkill && item.id === 'builtin:mobius-self-iter'
      const label = document.createElement('label')
      label.className = 'picker-item'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selected.has(item.id) || locked
      checkbox.disabled = locked
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(item.id)
        else selected.delete(item.id)
        count.textContent = `${selected.size}/${items.length} 已启用`
      })
      const copy = document.createElement('span')
      const name = document.createElement('span')
      name.className = 'picker-item-name'
      name.textContent = locked ? `${item.name} · 自进化必选` : item.name
      const description = document.createElement('span')
      description.className = 'picker-item-desc'
      description.textContent = item.description || `${item.scope} ${isSkill ? 'Skill' : 'Memory'}`
      copy.append(name, description)
      label.append(checkbox, copy)
      menu.appendChild(label)
    }
  }

  clearContextOptions() {
    this.selfIteration.skills = []
    this.selfIteration.memories = []
    this.selfIteration.selectedSkillIds = new Set()
    this.selfIteration.selectedMemoryIds = new Set()
    this.renderPicker('skill')
    this.renderPicker('memory')
  }

  async ensureSelfIterationOptions() {
    if (this.selfIteration.loaded) {
      this.renderSelects()
      this.renderPicker('skill')
      this.renderPicker('memory')
      return
    }
    if (this.bootstrapPromise) return this.bootstrapPromise
    this.setFormStatus('正在加载 Mobius 自进化项目、模型和上下文选项…')
    this.bootstrapPromise = loadSelfIterationBootstrap().then(async bootstrap => {
      this.selfIteration.loaded = true
      this.selfIteration.projects = bootstrap.projects
      this.selfIteration.models = bootstrap.models
      this.selfIteration.globalDefaultModel = bootstrap.globalDefaultModel
      this.selfIteration.userId = bootstrap.userId
      this.selfIteration.route = bootstrap.route
      const currentProjectValid = bootstrap.projects.some(project => String(project.id) === String(this.selfIteration.projectId))
      const routeProjectValid = bootstrap.projects.some(project => String(project.id) === String(bootstrap.route.projectId))
      this.selfIteration.projectId = currentProjectValid
        ? this.selfIteration.projectId
        : (routeProjectValid ? bootstrap.route.projectId : String(bootstrap.projects[0]?.id || ''))
      this.selfIteration.model = this.resolveModelDefault()
      this.renderSelects()
      if (!this.selfIteration.projects.length) {
        this.setFormStatus('未找到可用的 Mobius 自进化项目。', true)
        return
      }
      await this.loadIssuesForProject(this.selfIteration.projectId, bootstrap.route.issueId)
    }).catch(error => {
      this.setFormStatus(error?.message || '自进化会话选项加载失败', true)
      throw error
    }).finally(() => { this.bootstrapPromise = null })
    return this.bootstrapPromise
  }

  async loadIssuesForProject(projectId, preferredIssueId = '') {
    const version = ++this.selfIteration.issueRequestVersion
    ++this.selfIteration.contextRequestVersion
    this.selfIteration.issues = []
    this.selfIteration.issueId = ''
    this.clearContextOptions()
    this.renderSelects()
    if (!projectId) {
      this.setFormStatus('请选择 Mobius 自进化项目。')
      return
    }
    this.setFormStatus('正在加载项目下的开放 Issue…')
    try {
      const issues = await loadProjectIssues(projectId)
      if (version !== this.selfIteration.issueRequestVersion) return
      this.selfIteration.issues = issues
      const previousValid = issues.some(issue => String(issue.id) === String(preferredIssueId))
      this.selfIteration.issueId = previousValid ? String(preferredIssueId) : String(issues[0]?.id || '')
      this.selfIteration.model = this.resolveModelDefault()
      this.renderSelects()
      if (!this.selfIteration.issueId) {
        this.setFormStatus('该自进化项目暂无开放 Issue。', true)
        return
      }
      await this.loadContextForIssue(this.selfIteration.issueId)
    } catch (error) {
      if (version !== this.selfIteration.issueRequestVersion) return
      this.setFormStatus(error?.message || 'Issue 加载失败', true)
    }
  }

  async loadContextForIssue(issueId) {
    const version = ++this.selfIteration.contextRequestVersion
    this.clearContextOptions()
    this.renderSelects()
    if (!issueId) {
      this.setFormStatus('请选择 Mobius Issue。')
      return
    }
    this.setFormStatus('正在加载模型默认值、Skill 和 Memory…')
    try {
      const context = await loadIssueContext(issueId, this.elements.prompt.value)
      if (version !== this.selfIteration.contextRequestVersion) return
      this.selfIteration.skills = context.skills
      this.selfIteration.memories = context.memories
      const excludedSkills = new Set(context.defaults?.excluded_skill_ids || [])
      const excludedMemories = new Set(context.defaults?.excluded_memory_ids || [])
      this.selfIteration.selectedSkillIds = new Set(context.skills.filter(item => !excludedSkills.has(item.id)).map(item => item.id))
      this.selfIteration.selectedMemoryIds = new Set(context.memories.filter(item => !excludedMemories.has(item.id)).map(item => item.id))
      if (context.skills.some(item => item.id === 'builtin:mobius-self-iter')) {
        this.selfIteration.selectedSkillIds.add('builtin:mobius-self-iter')
      }
      if (!this.selfIteration.modelTouched) this.selfIteration.model = this.resolveModelDefault(context.defaults?.model)
      this.renderSelects()
      this.renderPicker('skill')
      this.renderPicker('memory')
      this.setFormStatus(`已就绪：${context.skills.length} 个 Skill，${context.memories.length} 个 Memory。`)
    } catch (error) {
      if (version !== this.selfIteration.contextRequestVersion) return
      this.setFormStatus(error?.message || 'Skill / Memory 加载失败', true)
    }
  }

  refreshGeneratedPrompt(updateRequirementInDirtyPrompt = false, force = false) {
    if (!this.selections.length) return
    const previousGenerated = this.generatedPrompt
    const nextGenerated = buildAgentPrompt(
      this.selections.map(entry => entry.snapshot),
      this.selections.map(entry => entry.locationResult),
      this.elements.requirement.value,
    )
    if (force || this.elements.prompt.value === previousGenerated) {
      this.elements.prompt.value = nextGenerated
    } else if (updateRequirementInDirtyPrompt) {
      this.elements.prompt.value = replacePromptRequirement(this.elements.prompt.value, this.elements.requirement.value)
    }
    this.generatedPrompt = nextGenerated
  }

  async startSelfIteration() {
    if (this.startingSelfIteration) return
    const requirement = this.elements.requirement.value.trim()
    if (!requirement) {
      this.setFormStatus('请先输入具体的界面改进要求。', true)
      this.elements.requirement.focus()
      return
    }
    const project = this.selectedProject()
    const issue = this.selectedIssue()
    if (!project) { this.setFormStatus('请选择 Mobius 自进化项目。', true); return }
    if (!issue) { this.setFormStatus('请选择 Mobius Issue。', true); return }
    if (!this.selfIteration.model) { this.setFormStatus('请选择模型。', true); return }

    this.startingSelfIteration = true
    this.elements.start.disabled = true
    this.elements.start.textContent = '正在创建并启动…'
    this.setFormStatus('正在创建 Session，并向 Agent 发送首条任务消息…')
    try {
      const result = await createAndStartSelfIteration({
        project,
        issue,
        model: this.selfIteration.model,
        prompt: this.elements.prompt.value,
        skills: this.selfIteration.skills,
        memories: this.selfIteration.memories,
        selectedSkillIds: this.selfIteration.selectedSkillIds,
        selectedMemoryIds: this.selfIteration.selectedMemoryIds,
        userId: this.selfIteration.userId,
      })
      this.lastCreatedSession = result
      this.elements.confirmTitle.textContent = '自进化会话已创建并启动'
      this.elements.confirmCopy.textContent = `会话“${result.name}”已开始运行。是否现在进入该会话查看进度？`
      this.elements.confirmLayer.hidden = false
      this.setFormStatus('自进化会话已创建并启动。')
    } catch (error) {
      if (error?.createdSession) {
        this.lastCreatedSession = error.createdSession
        this.elements.confirmTitle.textContent = '自进化会话已创建'
        this.elements.confirmCopy.textContent = `会话“${error.createdSession.name}”已创建，但启动确认未及时返回。为避免重复创建，建议进入该会话查看实际运行状态。`
        this.elements.confirmLayer.hidden = false
        this.setFormStatus('会话已创建；启动确认未及时返回，请进入会话查看。')
      } else {
        this.setFormStatus(error?.message || '创建或启动自进化会话失败', true)
        this.showToast(error?.message || '启动自进化失败', true)
      }
    } finally {
      this.startingSelfIteration = false
      this.elements.start.disabled = false
      this.elements.start.textContent = '启动自进化'
    }
  }

  openSelection(selection) {
    const existingIndex = this.selections.findIndex(entry => entry.element === selection.semantic)
    if (existingIndex >= 0) {
      this.selectedElement = selection.semantic
      this.modalOpen = true
      this.drawOutline(selection.semantic, selection.exact)
      this.elements.shield.hidden = true
      this.elements.modalLayer.hidden = false
      this.renderSelectionSummary()
      this.updateToolbar()
      this.showToast(`该元素已是元素${existingIndex + 1}`)
      return
    }

    const firstSelection = this.selections.length === 0
    const entry = {
      element: selection.semantic,
      exact: selection.exact,
      snapshot: createElementSnapshot(selection),
      locationResult: null,
      locating: true,
    }
    this.selections.push(entry)
    this.selectedElement = selection.semantic
    this.modalOpen = true
    this.drawOutline(selection.semantic, selection.exact)
    this.elements.shield.hidden = true
    this.elements.modalLayer.hidden = false
    this.renderSelectionSummary()
    this.renderSelectedOutlines()
    this.elements.pageSummary.textContent = entry.snapshot.page.path
    if (firstSelection) this.elements.requirement.value = ''
    this.updateLocatorStatus()
    this.refreshGeneratedPrompt(false, true)
    this.updateToolbar()
    this.elements.confirmLayer.hidden = true
    this.lastCreatedSession = null
    this.ensureSelfIterationOptions().catch(() => {})
    window.addEventListener('scroll', this.refreshSelectedOutline, true)
    window.addEventListener('resize', this.refreshSelectedOutline)

    locateSource(entry.snapshot).then(result => {
      if (!this.selections.includes(entry)) return
      entry.locationResult = result
      entry.locating = false
      this.refreshGeneratedPrompt(false)
      this.updateLocatorStatus()
    }).catch(() => {
      if (!this.selections.includes(entry)) return
      entry.locationResult = { candidates: [], unavailable: '源码定位暂不可用，已使用本地 DOM 指纹生成提示词。' }
      entry.locating = false
      this.refreshGeneratedPrompt(false)
      this.updateLocatorStatus()
    })
  }

  resumeSelection() {
    if (!this.active) return
    this.modalOpen = false
    this.elements.modalLayer.hidden = true
    this.elements.confirmLayer.hidden = true
    this.elements.shield.hidden = false
    this.elements.outline.hidden = true
    this.renderSelectedOutlines()
    this.updateToolbar()
    window.removeEventListener('scroll', this.refreshSelectedOutline, true)
    window.removeEventListener('resize', this.refreshSelectedOutline)
  }

  clearSelectionsAndResume() {
    this.selections = []
    this.selectedElement = null
    this.generatedPrompt = ''
    if (this.elements) {
      this.elements.requirement.value = ''
      this.elements.prompt.value = ''
      this.renderSelectedOutlines()
      this.updateToolbar()
    }
    this.resumeSelection()
  }

  showToast(message, error = false) {
    window.clearTimeout(this.toastTimer)
    this.elements.toast.textContent = message
    this.elements.toast.style.background = error ? 'rgba(190, 24, 93, .96)' : 'rgba(5, 150, 105, .95)'
    this.elements.toast.hidden = false
    this.toastTimer = window.setTimeout(() => { this.elements.toast.hidden = true }, 1800)
  }
}
