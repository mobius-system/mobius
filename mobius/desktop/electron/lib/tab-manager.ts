// TabManager：桌面端多 tab 编排（实验版 0.0.12）。
// 每个 tab = 一个独立 WebContentsView，挂到 mainWindow.contentView。同一时间只显示激活 tab，
// 其余 setVisible(false) 但保留 webContents（保留各自 SPA 全量状态，天然隔离）。
// tab 栏（前端组件 desktop-tab-bar.tsx）经 IPC tabs:* 订阅状态、发指令；每个 tab 的 tab 栏互为镜像。
//
// 设计要点：
// - window.open 拦截：同源 URL → 新 tab；外链 → 系统浏览器（openExternal）。复用前端 20 处 window.open(_blank)。
// - will-navigate 限定登录服务器 origin（防钓鱼），同 main.ts 既有逻辑。
// - aimux supervisor / seedWebAuth 仍全局一份（共享 defaultSession），本类不管。
// - 布局：tab 栏是前端 fixed 浮层不占空间 → 每个 view 铺满窗口客户区。
import { type BrowserWindow, WebContentsView, type WebContents, type WebPreferences } from "electron";
import { getLastTabs, setLastTabs } from "./desktop-settings";

export interface TabInfo {
  id: string;
  url: string; // pathname+search+hash（持久化 / 前端显示用，不含 origin）
  title?: string;
}

interface Tab {
  id: string;
  view: WebContentsView;
  pathOnly: string; // pathname+search+hash
  title?: string;
}

export interface TabManagerOptions {
  window: () => BrowserWindow | null; // 主窗口 getter（延迟求值，规避模块级 null）
  serverOrigin: () => string; // 登录服务器 origin（creds 变化时动态）
  username: () => string; // 当前用户名
  homePath: () => string; // 新建空白 tab 默认 pathname（如 /u/username）
  webPreferences: WebPreferences; // 每个 view 的 webPreferences（复用 main.ts 配置）
  openExternal: (url: string) => void; // 外链 window.open → 系统浏览器
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  private readonly opts: TabManagerOptions;
  private seq = 0;

  constructor(opts: TabManagerOptions) {
    this.opts = opts;
  }

  private nextId(): string {
    this.seq += 1;
    return `tab-${this.seq}`;
  }

  private origin(): string {
    return this.opts.serverOrigin().replace(/\/$/, "");
  }

  private isSameOrigin(url: string): boolean {
    const o = this.origin();
    if (!o) return false;
    if (url === o) return true;
    try {
      return new URL(url, o).origin === new URL(o).origin;
    } catch {
      return url.startsWith(o + "/") || url.startsWith(o + "?") || url.startsWith(o + "#");
    }
  }

  /** 完整 url → pathname+search+hash；跨域或解析失败返 null。 */
  private toPathOnly(fullUrl: string): string | null {
    try {
      const u = new URL(fullUrl, this.origin());
      if (!this.isSameOrigin(u.origin)) return null;
      return u.pathname + u.search + u.hash;
    } catch {
      return null;
    }
  }

  getTabs(): TabInfo[] {
    return this.tabs.map((t) => ({ id: t.id, url: t.pathOnly, title: t.title }));
  }

  getActiveTabId(): string | null {
    return this.activeId;
  }

  /** 内容区 bounds = 窗口客户区。tab 栏前端 fixed 浮层不占布局 → view 铺满。 */
  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const win = this.opts.window();
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 1280, height: 800 };
    const b = win.getContentBounds();
    return { x: 0, y: 0, width: b.width, height: b.height };
  }

  /** 窗口 resize 时重布局所有 view（含隐藏的，确保下次显示位置正确）。 */
  relayout(): void {
    const b = this.contentBounds();
    for (const t of this.tabs) {
      try { t.view.setBounds(b); } catch { /* view 可能正在销毁 */ }
    }
  }

  private attachHandlers(wc: WebContents, tab: Tab): void {
    const origin = this.origin();
    // window.open 拦截：同源 → 新 tab；外链 → 系统浏览器。
    wc.setWindowOpenHandler(({ url }) => {
      if (this.isSameOrigin(url)) {
        const path = this.toPathOnly(url);
        if (path) this.createTab(path, { activate: true });
      } else {
        this.opts.openExternal(url);
      }
      return { action: "deny" };
    });
    // 只允许登录服务器 origin 内导航（防钓鱼），同 main.ts 既有逻辑。
    wc.on("will-navigate", (e, url) => {
      if (url.startsWith("file://")) return;
      if (origin && !url.startsWith(origin)) {
        e.preventDefault();
        return;
      }
      const path = this.toPathOnly(url);
      if (path) tab.pathOnly = path;
    });
    wc.on("did-navigate", (_e, url) => {
      const path = this.toPathOnly(url);
      if (path) {
        tab.pathOnly = path;
        this.broadcast();
        this.persist();
      }
    });
    // F12 切换 devtools（detach 模式），同 main.ts 既有 before-input-event。
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown" || input.key !== "F12") return;
      e.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: "detach" });
    });
    // 页面标题更新 → tab.title（tab 栏卡片显示）。
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title;
      this.broadcast();
    });
  }

  /** 创建一个 tab。pathOnly 为空则用 homePath。返回 tab id。 */
  createTab(pathOnly?: string, opts?: { activate?: boolean }): string {
    const win = this.opts.window();
    if (!win || win.isDestroyed()) return "";
    const path = pathOnly && pathOnly.trim() ? pathOnly : this.opts.homePath();
    const id = this.nextId();
    const view = new WebContentsView({ webPreferences: this.opts.webPreferences });
    const tab: Tab = { id, view, pathOnly: path, title: undefined };
    this.tabs.push(tab);
    win.contentView.addChildView(view);
    view.setBounds(this.contentBounds());
    view.setVisible(false);
    this.attachHandlers(view.webContents, tab);
    view.webContents.loadURL(this.origin() + path);
    if (opts?.activate ?? true) {
      this.activate(id, true);
    } else {
      this.broadcast();
    }
    this.persist();
    return id;
  }

  /** 激活指定 tab（显示它、隐藏其余），fromCreate 区分是否跳过重复 persist。
   *  先显新 view 再隐旧的，避免切换瞬间所有 view 都隐藏、about:blank 容器露出造成白闪。 */
  private activate(id: string, fromCreate = false): void {
    const target = this.tabs.find((t) => t.id === id);
    if (target) {
      try { target.view.setBounds(this.contentBounds()); } catch { /* ignore */ }
      try { target.view.setVisible(true); } catch { /* ignore */ }
    }
    for (const t of this.tabs) {
      if (t.id !== id) {
        try { t.view.setVisible(false); } catch { /* ignore */ }
      }
    }
    this.activeId = id;
    this.broadcast();
    if (!fromCreate) this.persist();
  }

  switchTab(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activate(id);
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const win = this.opts.window();
    const [removed] = this.tabs.splice(idx, 1);
    if (win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(removed.view); } catch { /* ignore */ }
    }
    this.destroyWebContents(removed.view.webContents);

    if (this.activeId === id) {
      // 关的是激活 tab：空了 → 建默认 home tab（保持至少一个页面）；否则激活相邻
      if (this.tabs.length === 0) {
        this.activeId = null;
        this.createTab(this.opts.homePath(), { activate: true });
        return;
      }
      const next = this.tabs[idx] || this.tabs[idx - 1];
      this.activate(next.id);
    } else {
      this.broadcast();
    }
    this.persist();
  }

  reorderTabs(ids: string[]): void {
    const map = new Map(this.tabs.map((t) => [t.id, t]));
    const ordered: Tab[] = [];
    for (const id of ids) {
      const t = map.get(id);
      if (t) ordered.push(t);
    }
    // 保留未在 ids 里的 tab（放末尾，避免丢失）
    for (const t of this.tabs) {
      if (!ids.includes(t.id)) ordered.push(t);
    }
    this.tabs = ordered;
    this.broadcast();
    this.persist();
  }

  /** 把任意 IPC 消息发到所有 tab view（供全局 broadcast 推 aimux/窗口状态；内部 tabs:changed 也走它）。 */
  sendToAllViews(channel: string, payload: unknown): void {
    for (const t of this.tabs) {
      try {
        if (!t.view.webContents.isDestroyed()) t.view.webContents.send(channel, payload);
      } catch { /* view 可能正在加载 */ }
    }
  }

  /** 广播 tab 状态给所有 tab view 的前端 tab 栏（每个 tab 镜像更新）。 */
  broadcast(): void {
    this.sendToAllViews("tabs:changed", { tabs: this.getTabs(), activeId: this.activeId });
  }

  /** 持久化当前 tab 列表（urls + 激活 url）。 */
  persist(): void {
    const u = this.opts.username();
    const s = this.opts.serverOrigin();
    if (!u || !s) return;
    const urls = this.tabs.map((t) => t.pathOnly);
    const active = this.tabs.find((t) => t.id === this.activeId);
    setLastTabs(s, u, { urls, activeUrl: active?.pathOnly });
  }

  /** 启动恢复：有 lastTabs 则按序重建并激活上次的 tab；否则建一个 home tab。 */
  restore(): void {
    const s = this.opts.serverOrigin();
    const u = this.opts.username();
    const saved = s && u ? getLastTabs(s, u) : null;
    if (saved && saved.urls.length > 0) {
      const want = (saved.activeUrl && saved.urls.includes(saved.activeUrl)) ? saved.activeUrl : saved.urls[0];
      for (const url of saved.urls) this.createTab(url, { activate: false });
      const target = this.tabs.find((t) => t.pathOnly === want) || this.tabs[0];
      if (target) this.activate(target.id);
    } else {
      this.createTab(this.opts.homePath(), { activate: true });
    }
  }

  /** reload 当前激活 tab（硬刷新，供「同步最新代码」菜单）。 */
  reloadActive(): void {
    const t = this.tabs.find((x) => x.id === this.activeId);
    try { t?.view.webContents.reloadIgnoringCache(); } catch { /* ignore */ }
  }

  /** 打开激活 tab 的 devtools。 */
  openDevTools(): void {
    const t = this.tabs.find((x) => x.id === this.activeId);
    try { t?.view.webContents.openDevTools({ mode: "detach" }); } catch { /* ignore */ }
  }

  /** 退出前清理所有 tab view。 */
  destroyAll(): void {
    const win = this.opts.window();
    for (const t of this.tabs) {
      if (win && !win.isDestroyed()) {
        try { win.contentView.removeChildView(t.view); } catch { /* ignore */ }
      }
      this.destroyWebContents(t.view.webContents);
    }
    this.tabs = [];
    this.activeId = null;
  }

  // WebContentsView 无显式 destroy；移除后显式销毁其 webContents，避免后台进程泄漏。
  private destroyWebContents(wc: WebContents): void {
    try {
      const w = wc as unknown as { destroy?: () => void; close?: () => void };
      if (typeof w.destroy === "function") w.destroy();
      else if (typeof w.close === "function") w.close();
    } catch { /* ignore */ }
  }
}
