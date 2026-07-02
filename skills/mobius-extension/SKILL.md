---
name: mobius-extension
description: 在莫比乌斯 AI 中开发一个新拓展插件 (特殊应用). 含后端 handler 协议、前端 SDK / 编译策略、目录与命名规范.
---

# 开发 mobius 拓展

拓展 = `mobius/extension/<name>/` 一个目录. 新 tab 打开 `/extension/<name>/` 运行, 后端走 `/api/ext` 转发, 数据落到 `APP_DIR/protected_data/extension/<name>/`. 样例: `mobius/extension/pacman/`.

```
mobius/extension/<name>/
├── extension.json
├── backend/extension_backend_handler.js
├── backend/...others...
└── frontend/index.html
└── frontend/...others(main.js / package.json / ...)...
```

---

## 1. 后端

文件固定 `backend/extension_backend_handler.js`, CommonJS, 导出 async 函数:

```js
module.exports = async function ({
  username,           // string, JWT 注入, 可信
  display_name,
  ext_main_payload,   // any JSON, 前端传的 payload
  ext_data_dir,       // 绝对路径, 你唯一可写区
  extension_name,
  logger,             // info/warn/error → ext_data_dir/_handler.log
}) {
  // 推荐按 ext_main_payload.action 分发
  return { ok: true, /* ... */ };  // 或 { ok: false, error: '...' }
};
```

硬约束 (违反 → 504/502/500/429):

| 项 | 上限 |
|---|---|
| 单次时长 | 30 s |
| 返回 JSON | 5 MB |
| 入参 payload | 1 MB |
| 速率 | 5 rps / 用户 |
| 内存 | 256 MB |
| 状态 | **stateless** -- 模块顶层不能有连接/定时器/cache, 每次新 worker_thread |
| 文件 IO | 只能 `path.join(ext_data_dir, ...)`, **不能** `process.chdir()` (worker_thread 禁用) |
| stdout | 不回流, 用 `logger.*` |

样例 (吃豆人排行榜):
```js
const path = require('path'), fs = require('fs/promises');
module.exports = async function ({ username, ext_main_payload, ext_data_dir }) {
  const lb = path.join(ext_data_dir, 'leaderboard.json');
  if (ext_main_payload.action === 'submit_score') {
    const score = Number(ext_main_payload.score) | 0;
    if (score < 0 || score > 1e7) return { ok: false, error: 'invalid score' };
    let list = []; try { list = JSON.parse(await fs.readFile(lb, 'utf8')); } catch {}
    list.push({ username, score, ts: Date.now() });
    list.sort((a, b) => b.score - a.score);
    await fs.writeFile(lb, JSON.stringify(list.slice(0, 100)));
    return { ok: true };
  }
};
```

handler 改动按 mtime 自动失效 require 缓存, 不用重启.

---

## 2. 前端

`frontend/index.html` 是入口. 后端自动注入 `<script>window.__EXT_NAME__="<name>";</script>` 到 `<head>`.

调用后端**只用** SDK, 别自己拼 `fetch('/api/ext')`:

```js
import { extCall } from '/extension/_sdk/ext.js';
const r = await extCall({ action: 'submit_score', score: 1234 });
// SDK 自动: 从 localStorage['cc-token'] 取 JWT + 填 extension_name + 包 ext_main_payload
```

编译策略二选一:

- **零编译**: 不写 `package.json`. 首访时后端把 `frontend/*` 拷到 `dist/`. 用浏览器原生 ESM. 改完调 `POST /api/admin/extensions/<name>/rebuild`.
- **vite/webpack**: `frontend/package.json` 含 `"build": "vite build"`, 产物必须在 `frontend/dist/index.html`. 首访自动 `npm install` + `npm run build`, 用户看 loading 页轮询. 日志: `protected_data/extension/<name>/_build.log`, 或 `GET /api/extensions/<name>/build-status`.

隔离: 新 tab = 独立 JS 引擎. 不要 import 主前端代码, 不要覆盖 `localStorage['cc-token']`.

---

## 3. 规范

**命名**: `<name>` 必须 `^[a-z][a-z0-9-]{0,31}$`, 且 `extension.json:name` = 目录名.

**manifest** (`extension.json`):
```json
{ "name": "<name>", "display_name": "中文名", "description": "...", "version": "0.1.0", "icon": "favicon.svg", "project": { "sync": true } }
```
不要写 entry / handler 路径, 是约定固定的. `project` 可选, 只有一个字段:
- `project.sync` (默认 `true`): `false` 时该拓展不进 DB, 完全不出现在任何项目列表里 (等同于"不启用"). 其它情况都会作为一个 kind=`extension` 的项目入库.
- ~~`project.default_hidden`~~: **已移除**. 拓展一律默认可见, 不再支持"默认隐藏"; 想让某拓展不出现, 用 `sync: false` 或直接不放进 `mobius/extension/`.

**可见性规则 (简单版)**: 每个拓展**默认对所有人可见**. 用户可在项目页**隐藏**任意拓展, 也可在「已屏蔽项目」里随时**恢复显示**——只对自己生效, 不影响别人, 不删数据. 后端只有一个可见性来源 (用户屏蔽 = `user_muted_projects`); 拓展卡片只提供"隐藏"一个动作. **彻底删除**某用户在该拓展的数据是**管理员专属**操作 (管理中心 → 拓展 → 已隐藏的拓展 → 彻底删除), 普通用户没有这个能力.

**特殊拓展项目** (kind=`extension` 的 project) 由 registry 自动 upsert, 锁死: `bind_path=APP_DIR`, `worktree=false`, `research=false`, `created_by=system` (但每个用户的项目页都能看到). 不能从 UI 删, 不能改 name/desc/path/repos/worktree/research, 可改 forgotten_flag.* 与星标.

**生命周期**: 新增 → `POST /api/admin/extensions/reload` (或 `python3 start.py` 重启). 删除 → 删目录 + reload, **DB 行保留** (标 disabled), 用户在该项目下的 issue/session 不丢; 目录补回 → reload → 自动恢复.

**调试套路**:
```bash
# JWT
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({id:'<uid>'},'<JWT_SECRET>',{expiresIn:'1h'}))")
# 列表 / 调 handler / 重 reload / 重新 build
# find $MOBIUS_PORT in `env var` or `.env` or `.env.default`, default 33314
curl -H "Authorization: Bearer $TOKEN" http://localhost:$MOBIUS_PORT/api/extensions
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"extension_name":"<name>","ext_main_payload":{"action":"..."}}' \
  http://localhost:$MOBIUS_PORT/api/ext
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:$MOBIUS_PORT/api/admin/extensions/reload
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:$MOBIUS_PORT/api/admin/extensions/<name>/rebuild
tail -f APP_DIR/protected_data/extension/<name>/_handler.log
tmux attach -t mobius-system   # 看后端实时日志
```

**禁忌**:
- handler 顶层持有状态 / 用 `process.chdir` / 写 `ext_data_dir` 之外的路径
- 直接 `fetch('/api/...')` 调 mobius 其他接口 (走 extCall 之外的 API 没有授权也没必要)
- 把 `node_modules/` / `dist/` 提交进仓库
- 信任 `ext_main_payload`: 一律校验类型 + 边界
- 回显 stack trace, 只返回 `{ ok:false, error:'简短' }`


## 4. 主项目联合修改

有时候只修改extension无法优雅地解决问题，需要主项目配合修改。**这是允许的**，但修改需要足够的通用性，不能只为一个特定的extension服务。
