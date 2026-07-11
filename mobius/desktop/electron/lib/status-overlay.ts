// 在远程 web UI 页面注入一个固定置顶的"aimux 连接状态"徽标。
// 不依赖 web UI 配合：主进程在 did-finish-load 插入 DOM，状态变化时 executeJavaScript 改文案/颜色。
import type { WebContents } from "electron";
import type { AimuxState } from "./aimux-supervisor";

const BADGE_ID = "__mobius_desktop_status_badge__";

const CSS = `
#${BADGE_ID} {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  font: 12px/1.4 -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  padding: 5px 10px; border-radius: 14px; color: #fff;
  background: rgba(40,40,40,0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  display: flex; align-items: center; gap: 6px; pointer-events: auto; cursor: pointer; user-select: none;
}
#${BADGE_ID}:hover { background: rgba(20,20,20,0.95); }
#${BADGE_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #999; }
#${BADGE_ID}.s-starting .dot { background: #f5a623; animation: __md_pulse 1s infinite; }
#${BADGE_ID}.s-connected .dot { background: #34c759; }
#${BADGE_ID}.s-failed   .dot { background: #ff3b30; }
#${BADGE_ID}.s-stopped  .dot { background: #999; }
@keyframes __md_pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
`;

const TEXT: Record<AimuxState, string> = {
  starting: "aimux 连接中…",
  connected: "aimux 已连接",
  failed: "aimux 断开",
  stopped: "aimux 已断开",
};

/** 首次进入远程页时插入徽标容器（已存在则跳过）。 */
export async function injectBadge(wc: WebContents): Promise<void> {
  try {
    await wc.insertCSS(CSS, { cssOrigin: "user" });
    await wc.executeJavaScript(`
      if (!document.getElementById('${BADGE_ID}')) {
        const el = document.createElement('div');
        el.id = '${BADGE_ID}';
        el.className = 's-starting';
        el.title = '点击查看 aimux 详情';
        el.innerHTML = '<span class="dot"></span><span class="txt">${TEXT.starting}</span>';
        el.onclick = () => { try { window.mobiusDesktop && window.mobiusDesktop.openStatusPanel && window.mobiusDesktop.openStatusPanel(); } catch (e) {} };
        document.documentElement.appendChild(el);
      }
      true;
    `);
  } catch {
    /* 页面可能尚未就绪或跨域受限，忽略，下次 did-finish-load 再试 */
  }
}

/** 状态变化时更新徽标文案与颜色。 */
export async function setBadge(wc: WebContents, state: AimuxState, detail?: string): Promise<void> {
  const text = detail ? `aimux: ${state}` : TEXT[state];
  try {
    await wc.executeJavaScript(`
      (() => {
        const el = document.getElementById('${BADGE_ID}');
        if (!el) return;
        el.className = 's-' + ${JSON.stringify(state)};
        const txt = el.querySelector('.txt'); if (txt) txt.textContent = ${JSON.stringify(text)};
      })();
      true;
    `);
  } catch {
    /* 忽略 */
  }
}
