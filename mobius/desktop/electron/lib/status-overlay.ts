// 在远程 web UI 页面注入一个可拖拽的"aimux 连接状态"徽标。
// 不依赖 web UI 配合：主进程在 did-finish-load 插入 DOM，状态变化时 executeJavaScript 改文案/颜色。
// 徽标可被用户拖到窗口内任意位置（边界 clamp 不出视口），位置持久化到 localStorage；
// 短按（位移 < 4px）仍触发点击打开状态面板。
import type { WebContents } from "electron";
import type { AimuxState } from "./aimux-supervisor";

const BADGE_ID = "__mobius_desktop_status_badge__";
const POS_KEY = "__mobius_desktop_badge_pos__";

const CSS = `
#${BADGE_ID} {
  position: fixed; left: 10px; top: 10px; z-index: 2147483647;
  font: 12px/1.4 -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  padding: 5px 10px; border-radius: 14px; color: #fff;
  background: rgba(40,40,40,0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  display: flex; align-items: center; gap: 6px; pointer-events: auto; cursor: grab; user-select: none;
  -webkit-user-drag: none; touch-action: none;
}
#${BADGE_ID}.dragging { cursor: grabbing; opacity: 0.92; }
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

/** 首次进入远程页时插入徽标容器（已存在则跳过），并绑定拖拽。 */
export async function injectBadge(wc: WebContents): Promise<void> {
  try {
    await wc.insertCSS(CSS, { cssOrigin: "user" });
    await wc.executeJavaScript(`
      (() => {
        if (document.getElementById('${BADGE_ID}')) return;
        const el = document.createElement('div');
        el.id = '${BADGE_ID}';
        el.className = 's-starting';
        el.title = '点击查看 aimux 详情；按住可拖动到任意位置';
        el.innerHTML = '<span class="dot"></span><span class="txt">${TEXT.starting}</span>';
        document.documentElement.appendChild(el);

        // —— 位置：localStorage 持久化，缺省顶部居中；始终 clamp 不出视口 ——
        function setPos(x, y) {
          const w = el.offsetWidth || 120, h = el.offsetHeight || 28;
          const mx = Math.max(0, window.innerWidth - w);
          const my = Math.max(0, window.innerHeight - h);
          el.style.left = Math.min(Math.max(0, x), mx) + 'px';
          el.style.top  = Math.min(Math.max(0, y), my) + 'px';
        }
        function getPos() { return [parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0]; }

        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('${POS_KEY}') || 'null'); } catch (e) {}
        if (saved && Array.isArray(saved) && saved.length === 2 && typeof saved[0] === 'number') {
          setPos(saved[0], saved[1]);
        } else {
          setPos((window.innerWidth - (el.offsetWidth || 120)) / 2, 10);
        }
        window.addEventListener('resize', () => { const p = getPos(); setPos(p[0], p[1]); });

        // —— 拖拽（pointer events 统一鼠标/触屏；setPointerCapture 让指针离开元素仍跟随）——
        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
        el.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          dragging = true; moved = false;
          sx = e.clientX; sy = e.clientY; const p = getPos(); ox = p[0]; oy = p[1];
          el.classList.add('dragging');
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
        });
        el.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          const dx = e.clientX - sx, dy = e.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return; // 小位移视作点击
          moved = true;
          setPos(ox + dx, oy + dy);
        });
        function endDrag(e) {
          if (!dragging) return;
          dragging = false;
          el.classList.remove('dragging');
          try { el.releasePointerCapture(e.pointerId); } catch (err) {}
          if (moved) { const p = getPos(); try { localStorage.setItem('${POS_KEY}', JSON.stringify(p)); } catch (err) {} }
        }
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);

        // —— 点击（非拖拽）打开状态面板 ——
        el.addEventListener('click', (e) => {
          if (moved) { e.preventDefault(); e.stopPropagation(); return; }
          try { window.mobiusDesktop && window.mobiusDesktop.openStatusPanel && window.mobiusDesktop.openStatusPanel(); } catch (err) {}
        });
      })();
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
        el.classList.remove('s-starting','s-connected','s-failed','s-stopped');
        el.classList.add('s-' + ${JSON.stringify(state)}); // 保留 dragging 类
        const txt = el.querySelector('.txt'); if (txt) txt.textContent = ${JSON.stringify(text)};
      })();
      true;
    `);
  } catch {
    /* 忽略 */
  }
}
