/**
 * web-terminal.ts — 会话内 Web 终端 (鉴权 WS + node-pty).
 *
 * 流程:
 *   1. 前端 new WebSocket(`/api/terminal/ws?sid=<sessionId>&token=<jwt>`)
 *   2. server.js 的 upgrade 事件按路径前缀 /api/terminal/ 路由到本模块 handleUpgrade
 *   3. 校验 JWT (query.token 或 cookie cc-token) → 拿到 user.id
 *   4. Sessions.findByIdForUser(sid, user.id) 校验该 session 属于该用户 (越权即拒)
 *   5. 取 session → project.bind_path 作为终端 cwd (不存在/无权限则回落 process.cwd())
 *   6. node-pty 起一个 shell, 双向桥接 ws <-> pty
 *   7. ws 关闭 / pty 退出 → 互相关闭, 单连接单 pty, 关即清理 (不持久化, 不复用)
 *
 * 安全: terminal = 任意命令执行, 必须 JWT 鉴权 + session 归属校验, 无 token 一律 socket.destroy().
 * 参考实现: backend/routes/code-server-proxy.ts 的 verifyJwt / handleUpgrade 模式.
 *
 * 消息协议:
 *   BE → FE: pty 输出原样 ws.send(string) (text frame), 前端 terminal.write(string).
 *   FE → BE: JSON 信封 {type:'input',data:string} | {type:'resize',cols,rows}.
 *     (xterm onData 给的是 JS 字符串, 含 ANSI/转义序列, JSON 字符串可无损往返.)
 */
import jwt from 'jsonwebtoken';
// @ts-ignore — ws 是 CommonJS, 无 TS 类型
import { WebSocketServer } from 'ws';
// node-pty 是原生模块, 部分环境缺失 → 缺失时 web 终端降级(拒绝连接)但不阻塞服务启动.
// @ts-ignore
let pty: any = null;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}
import fs from 'fs';
import { JWT_SECRET } from '../config';
// @ts-ignore — repository 仍是 .js 语义, tsx 透明转译
import { Sessions } from '../repositories/sessions';
// @ts-ignore
import { Projects } from '../repositories/projects';
// @ts-ignore — service 仍是 .js
import * as modelRegistry from '../services/model-registry';

// noServer 模式: 由 server.js 的 upgrade 事件手动分发到 handleUpgrade, 共享一个 WSS.
const wss = new WebSocketServer({ noServer: true });

function queryParam(rawUrl: string, name: string): string {
  try {
    return new URL(rawUrl, 'http://x').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

// token 优先 query (?token=), 兼容 cookie cc-token (与 store.ts localStorage 'cc-token' 同名).
function extractToken(req: any): string | null {
  const q = queryParam(req.url, 'token');
  if (q) return q;
  try {
    const m = (req.headers?.cookie || '').match(/cc-token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* fallthrough */ }
  return null;
}

function verifyUser(token: string | null): { id: string; role?: string } | null {
  if (!token) return null;
  try {
    const u = jwt.verify(token, JWT_SECRET) as any;
    return u && u.id ? { id: u.id, role: u.role } : null;
  } catch {
    return null;
  }
}

// 解析终端 cwd: session 归属校验 + 取项目 bind_path. 返回 denied=true 表示无权/不存在.
type TerminalMode = 'cwd' | 'agent';

const AGENT_TMUX_HUBS: Record<string, string> = {
  'tmux-codex': 'imac_codex_agent_hub',
  'tmux-claude-code': 'imac_claude_code_agent_hub',
};

function terminalMode(rawUrl: string): TerminalMode {
  return queryParam(rawUrl, 'mode') === 'agent' ? 'agent' : 'cwd';
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function agentTmuxTarget(session: any): string | null {
  const backend = modelRegistry.backendNameForSessionModel(session?.model);
  const hub = AGENT_TMUX_HUBS[backend];
  if (!hub) return null;
  return `${hub}:${session.session_id}`;
}

function resolveSessionTerminal(sid: string, userId: string): { cwd: string; denied: boolean; session: any | null } {
  const session = Sessions.findByIdForUser(sid, userId);
  if (!session) return { cwd: '', denied: true, session: null };
  if (session.project_id) {
    const p = Projects.findById(session.project_id);
    const bp = p?.bind_path;
    if (bp && fs.existsSync(bp) && fs.statSync(bp).isDirectory()) {
      return { cwd: bp, denied: false, session };
    }
  }
  // research/issue session 若项目无可用 bind_path, 回落到后端进程 cwd, 保证总能开.
  return { cwd: process.cwd(), denied: false, session };
}

export function handleUpgrade(req: any, socket: any, head: Buffer): void {
  const user = verifyUser(extractToken(req));
  if (!user) { socket.destroy(); return; }

  const sid = queryParam(req.url, 'sid');
  if (!sid) { socket.destroy(); return; }

  const mode = terminalMode(req.url);
  const { cwd, denied, session } = resolveSessionTerminal(sid, user.id);
  if (denied) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws: any) => {
    if (!pty) {
      try { ws.close(1011, 'web terminal unavailable: node-pty not installed'); } catch { /* ignore */ }
      console.error('[web-terminal] node-pty not installed, rejecting terminal connection');
      return;
    }
    const shell = process.env.SHELL || 'bash';
    let term: any;
    try {
      const env = { ...process.env, TERM: 'xterm-256color' } as any;
      delete env.TMUX;
      term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (e) {
      console.error('[web-terminal] spawn failed:', (e as Error).message);
      try { ws.close(1011, 'spawn failed'); } catch { /* ignore */ }
      return;
    }

    console.log(`[web-terminal] open user=${user.id} sid=${sid} mode=${mode} cwd=${cwd} pid=${term.pid}`);

    if (mode === 'agent') {
      const target = agentTmuxTarget(session);
      const attachCommand = target
        ? `tmux attach -t ${shellQuote(target)}`
        : `printf '%s\\n' ${shellQuote('当前 Session 的模型没有可 attach 的 Agent tmux 后台')}`;
      setTimeout(() => {
        try { term.write(`${attachCommand}\r`); } catch { /* ignore */ }
      }, 200);
    }

    // pty 输出 → 浏览器
    term.onData((chunk: string) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(chunk); } catch { /* ignore */ }
      }
    });
    // 进程退出 → 关 ws
    term.onExit(() => {
      try { ws.close(1000); } catch { /* ignore */ }
    });

    // 浏览器 → pty (JSON 信封: input / resize)
    ws.on('message', (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return; // 非 JSON 直接忽略, 不当作输入, 避免误注入
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        try { term.write(msg.data); } catch { /* ignore */ }
      } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try {
          term.resize(Math.max(1, Math.floor(msg.cols)), Math.max(1, Math.floor(msg.rows)));
        } catch { /* ignore */ }
      }
    });

    // ws 关闭/出错 → 杀 pty, 防泄漏
    const cleanup = () => {
      try { term.kill(); } catch { /* ignore */ }
    };
    ws.on('close', () => {
      console.log(`[web-terminal] close user=${user.id} sid=${sid} pid=${term.pid}`);
      cleanup();
    });
    ws.on('error', cleanup);
  });
}

export {};
