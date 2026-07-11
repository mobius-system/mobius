// 项目本地路径绑定的 overlay + toast：注入到远程 web UI 页面（同 badge 思路）。
// 用 createElement 构建 DOM（不用 innerHTML 模板字符串），避免引号转义地狱。
// 按钮经 window.mobiusDesktop bridge 回调主进程（pickDirectory / confirmProjectPath）。
import type { WebContents } from "electron";

const OVERLAY_ID = "__mobius_project_path_overlay__";
const TOAST_ID = "__mobius_desktop_toast__";

const CSS = `
#${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483646; }
#${OVERLAY_ID} .mdpp-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
#${OVERLAY_ID} .mdpp-card { width: 460px; max-width: calc(100vw - 40px); background: #fff; border-radius: 14px; padding: 22px 24px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1d1d1f; }
#${OVERLAY_ID} h3 { margin: 0 0 10px; font-size: 16px; }
#${OVERLAY_ID} .mdpp-msg { margin: 0 0 14px; font-size: 13px; color: #6e6e73; }
#${OVERLAY_ID} label { display: block; font-size: 12px; color: #8e8e93; margin-bottom: 6px; }
#${OVERLAY_ID} .mdpp-row { display: flex; gap: 8px; }
#${OVERLAY_ID} .mdpp-row input { flex: 1; padding: 9px 11px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 13px; outline: none; }
#${OVERLAY_ID} .mdpp-row input:focus { border-color: #0a84ff; }
#${OVERLAY_ID} .mdpp-row button { padding: 0 14px; border: 1px solid #d2d2d7; background: #f5f5f7; border-radius: 8px; font-size: 13px; cursor: pointer; }
#${OVERLAY_ID} .mdpp-actions { margin-top: 16px; display: flex; justify-content: flex-end; }
#${OVERLAY_ID} .mdpp-primary { padding: 9px 20px; border: none; border-radius: 9px; background: #0a84ff; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
#${OVERLAY_ID} .mdpp-primary:disabled { opacity: 0.6; cursor: default; }
#${TOAST_ID} { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); z-index: 2147483647; padding: 10px 18px; border-radius: 10px; font: 13px/1.4 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #fff; background: rgba(40,40,40,0.94); box-shadow: 0 4px 16px rgba(0,0,0,0.25); transition: opacity 0.3s; opacity: 0; pointer-events: none; max-width: calc(100vw - 40px); }
#${TOAST_ID}.ok { background: rgba(48,138,76,0.96); }
#${TOAST_ID}.err { background: rgba(209,72,54,0.96); }
`;

export interface OverlayOpts {
  projectId: string;
  projectName: string;
  defaultPath: string;
  machineInfo: string;
}

export async function injectProjectPathOverlay(wc: WebContents, opts: OverlayOpts): Promise<void> {
  try {
    await wc.insertCSS(CSS, { cssOrigin: "user" });
    // 纯 createElement 构建，所有动态值经 JSON.stringify 安全嵌入
    const script = `
(function(){
  if (document.getElementById(${JSON.stringify(OVERLAY_ID)})) return;
  var o = ${JSON.stringify(opts)};
  var root = document.createElement('div'); root.id = ${JSON.stringify(OVERLAY_ID)};
  var back = document.createElement('div'); back.className = 'mdpp-backdrop';
  var card = document.createElement('div'); card.className = 'mdpp-card';
  var h = document.createElement('h3'); h.textContent = '绑定本地工作路径';
  var p = document.createElement('p'); p.className = 'mdpp-msg';
  p.textContent = '本项目「' + o.projectName + '」还没有绑定这台机器（' + o.machineInfo + '）的本地工作路径。您必须选择一个本地路径才能继续。';
  var lab = document.createElement('label'); lab.textContent = '本地路径';
  var row = document.createElement('div'); row.className = 'mdpp-row';
  var input = document.createElement('input'); input.type = 'text'; input.value = o.defaultPath; input.style.width = '100%';
  var browse = document.createElement('button'); browse.textContent = '浏览…';
  var actions = document.createElement('div'); actions.className = 'mdpp-actions';
  var confirm = document.createElement('button'); confirm.className = 'mdpp-primary'; confirm.textContent = '确认绑定';
  row.appendChild(input); row.appendChild(browse);
  actions.appendChild(confirm);
  card.appendChild(h); card.appendChild(p); card.appendChild(lab); card.appendChild(row); card.appendChild(actions);
  back.appendChild(card); root.appendChild(back); document.documentElement.appendChild(root);
  input.focus(); input.select();
  browse.onclick = async function () {
    var d = await window.mobiusDesktop.pickDirectory();
    if (d) input.value = d;
  };
  confirm.onclick = async function () {
    confirm.disabled = true; confirm.textContent = '处理中…';
    var r = await window.mobiusDesktop.confirmProjectPath(o.projectId, input.value);
    if (!r || !r.ok) { confirm.disabled = false; confirm.textContent = '确认绑定'; alert((r && r.error) || '绑定失败'); }
  };
})();
true;`;
    await wc.executeJavaScript(script);
  } catch (e) {
    console.error("[project-overlay] 注入失败:", e);
  }
}

export async function dismissOverlay(wc: WebContents): Promise<void> {
  try {
    await wc.executeJavaScript(`var e=document.getElementById(${JSON.stringify(OVERLAY_ID)}); if(e) e.remove(); true;`);
  } catch { /* ignore */ }
}

export async function injectToast(wc: WebContents, msg: string, type: "ok" | "err" | "info"): Promise<void> {
  try {
    await wc.executeJavaScript(`
(function(){
  var id = ${JSON.stringify(TOAST_ID)};
  var t = document.getElementById(id);
  if (!t) { t = document.createElement('div'); t.id = id; document.documentElement.appendChild(t); }
  t.className = ${JSON.stringify(type)};
  t.textContent = ${JSON.stringify(msg)};
  t.style.opacity = '1';
  clearTimeout(t.__h);
  t.__h = setTimeout(function(){ t.style.opacity = '0'; }, 3600);
})();
true;`);
  } catch { /* ignore */ }
}
