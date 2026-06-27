// matrix-rain/frontend/main.js — 黑客帝国数字瀑布雨.
//
// 数据源: EventSource('/api/token_stream') —— 主后端 SSE (反代自 token-proxy 进程).
// 每收到一个真实 token 片段, 把它的字符喂给某一列, 让模型的流式输出顺着该列"流"下来
// (高亮白绿色, 与普通绿色片假名/数字雨点区分). 无 token 时退化为纯装饰雨, 不黑屏.
//
// 状态/控制走 SDK (extCall); 实时数据流走 EventSource (见 backend handler 注释 + SKILL §4).

import { extCall } from '/extension/_sdk/ext.js';

const canvas = document.getElementById('rain');
const ctx = canvas.getContext('2d', { alpha: false });

const FS = 16;            // 字号 / 行高 (px)
const SPEED_MS = 50;      // 每帧间隔 (~20fps, 数字雨不需要更快)

// 经典矩阵字符集 (片假名 + 数字 + 部分拉丁/符号). token 字符会单独高亮混入.
const FILLER = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFGHJKLMNPQRSTUVWXYZ:.=*+-/<>{}[]'.split('');

let W = 0, H = 0, COLS = 0;
let drops = [];        // 每列当前 head 所在行 (向下递增)
let queues = [];       // 每列待喷出的真实 token 字符队列
let nextCol = 0;       // 轮转: 下一个 token 喂给哪一列
let tokenCount = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  COLS = Math.max(1, Math.floor(W / FS));
  // 保持列数与数组长度一致 (缩窗时增删列).
  while (drops.length < COLS) {
    drops.push(Math.floor(Math.random() * (-H / FS)));
    queues.push([]);
  }
  drops.length = COLS;
  queues.length = COLS;
  // 清底, 避免缩放残留.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
}
window.addEventListener('resize', resize);
resize();

function randFiller() {
  return FILLER[(Math.random() * FILLER.length) | 0];
}

// 把一个 token 字符串拆成字符, 整体喂给某一列 (轮转), 让该列把它顺流喷出.
function feedToken(text) {
  if (!text) return;
  const chars = [...text];   // unicode 安全拆分
  const col = nextCol % COLS;
  nextCol = (nextCol + 1) % COLS;
  const q = queues[col];
  // 防止单列堆积过多 (token 风暴时保护): 单列上限 256 字符.
  for (const ch of chars) {
    if (ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (q.length < 256) q.push(ch);
  }
  tokenCount += chars.length;
  const el = document.getElementById('tok-count');
  if (el) el.textContent = String(tokenCount);
}

function drawFrame() {
  // 半透明黑覆盖产生拖尾衰减.
  ctx.fillStyle = 'rgba(0,0,0,0.075)';
  ctx.fillRect(0, 0, W, H);
  ctx.font = `${FS}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';

  for (let i = 0; i < COLS; i++) {
    const x = i * FS;
    const y = drops[i] * FS;
    if (y > -FS && y < H) {
      const q = queues[i];
      const isToken = q.length > 0;
      const ch = isToken ? q.shift() : randFiller();
      // head: 头部更亮; token 字符白绿 + 辉光, 其余普通绿.
      ctx.fillStyle = isToken ? '#e8ffe8' : '#3cff66';
      ctx.shadowColor = isToken ? '#00ff41' : 'rgba(0,255,65,0.6)';
      ctx.shadowBlur = isToken ? 10 : 4;
      ctx.fillText(ch, x, y);
      ctx.shadowBlur = 0;
      // 紧随其后的尾字符稍暗, 增强层次 (仅当不是 token 流时画一个 filler 尾巴).
      if (!isToken && y - FS > 0 && Math.random() < 0.6) {
        ctx.fillStyle = 'rgba(0,255,65,0.35)';
        ctx.fillText(randFiller(), x, y - FS);
      }
    }
    drops[i] += 1;
    // 落出底部后, 以小概率重置回顶部, 制造错落节奏.
    if (drops[i] * FS > H && Math.random() > 0.975) {
      drops[i] = Math.floor(Math.random() * -10);
    }
  }
}

let raf = 0, last = 0;
function loop(t) {
  raf = requestAnimationFrame(loop);
  if (t - last < SPEED_MS) return;
  last = t;
  drawFrame();
}
raf = requestAnimationFrame(loop);

// ── 实时 token 流 (SSE) ──────────────────────────────────────────────────
function connectFeed() {
  try {
    const es = new EventSource('/api/token_stream');
    es.addEventListener('snapshot', (e) => {
      try {
        const data = JSON.parse(e.data);
        const toks = Array.isArray(data.tokens) ? data.tokens : [];
        // 把近期快照里的 token 字符均匀铺开喂入各列, 连上当前流.
        for (let k = 0; k < toks.length; k++) feedToken(toks[k].text || '');
      } catch {}
    });
    es.addEventListener('token', (e) => {
      try {
        const entry = JSON.parse(e.data);
        feedToken(entry.text || '');
      } catch {}
    });
    es.onerror = () => { /* EventSource 会自动重连, 此处不处理 */ };
  } catch (e) {
    // 某些环境不支持 EventSource 时静默, 装饰雨照常跑.
  }
}
connectFeed();

// ── token-proxy 存活探测 (HUD) ───────────────────────────────────────────
async function pollStatus() {
  const dot = document.getElementById('proxy-dot');
  const text = document.getElementById('proxy-text');
  try {
    const r = await extCall({ action: 'proxy_status' });
    if (r && r.online) {
      if (dot) { dot.className = 'dot on'; }
      if (text) text.textContent = 'token-proxy 在线 · 等待捕获';
      return;
    }
    if (dot) { dot.className = 'dot off'; }
    if (text) text.textContent = 'token-proxy 离线 (数字雨仍可看, 但暂无实时 token)';
  } catch {
    if (dot) { dot.className = 'dot off'; }
    if (text) text.textContent = '状态未知';
  }
}
pollStatus();
setInterval(pollStatus, 10000);
