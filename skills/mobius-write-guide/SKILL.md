---
name: mobius-write-guide
description: 制作 Mobius 图文使用教程（理解用户意图 → Playwright 截图 → 红色编号标注 → 上传图床 → 写 markdown → 改 mkdocs → 本地构建验证 → commit/push 的全流程）。当用户说"加教程 / 写教程 / 图文教程 / tutorial"或要求把某个功能做成带截图的指南时使用。含本机所有硬编码常量、安全红线（绝不能截到密钥）和踩过的坑。
---

# Mobius 图文教程制作技能

把一个 Mobius 功能做成**带标记截图**的双语图文教程，发布到 mkdocs 文档站（GitHub Pages）。本技能是 `docs/tutorial/04~14` 这一批教程的制作经验沉淀，**所有命令、常量、坑都是实测过的**，照做即可。

## 全流程总览

```
0. 理解用户 → 1. Playwright 截图(原始+矩形) → 2. PIL 标注 → 3. 上传图床
→ 4. 写 .md + .en.md → 5. 改 mkdocs.yml + index → 6. mkdocs build 验证
→ 7. commit + push (gitlab 直连, github 走 proxychains)
```

> 全程**不要污染真实数据**：需要演示数据时新建临时项目/示例记忆，**做完删掉**。
> 全程**绝不能让密钥、token、私钥路径进入截图**（见末尾安全红线）。

---

## 0. 理解用户、规划

- **确认主题与边界**：要讲哪个功能？从入口到结果完整覆盖，一般 3–6 张图。
- **确认归类与位置**：参考现有 `mkdocs.yml` 的 nav 分区（I-五分钟精通 / II-高级能力 / III-管理员基础 / IV-自我进化能力 / V-小技巧 / VI-深度研究）。问清放在哪个分区、是否新建分区；用户常会指定"靠前"。**新建分区时要同步：nav 加顶层段 + nav_translations 加 section 中文名 + index.md/index.en.md 加 `###` 段**，三处缺一不可。
- **确认命名**：章节中文名（用户经常随手改名，如「万能捷径：小莫助理」），同步想好英文 nav key（如 `Xiaomo: Universal Shortcut`）。
- **先读代码再截**：grep 前端 `data-tour="..."` 选择器、读相关组件，确保步骤文案和真实 UI 一致，也方便定位截图元素。
- **编号**：用下一个可用编号（看 `docs/tutorial/` 最大号 +1），文件名 `<NN>_<snake_name>.md`。

---

## 1. Playwright 截图（原始 PNG + 元素矩形）

### 环境（已装好，无需再 install）
playwright 不在仓库内、在 npx 缓存里，且**缓存目录哈希会变，别写死**——用一行 find 自动发现：
```bash
NP=$(find /home/tianyi/.npm/_npx -maxdepth 3 -type d -name node_modules 2>/dev/null | head -1)
NODE_PATH="$NP" node /tmp/your_script.js
# 验证: NODE_PATH="$NP" node -e "require('playwright');console.log('ok')"
```
若 find 为空（缓存被清），随便 `npx playwright ...` 跑一次会重建。Chromium 浏览器缓存在 `~/.cache/ms-playwright`。

### 登录 + 关首登引导（写死，密码免登）
```js
const TOKEN = process.env.MOB_TOKEN; // 或 curl 取: 见下方"关键常量"
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript((t) => {
  try { localStorage.setItem('cc-token', t); } catch(e){}                    // 登录态
  try { localStorage.setItem('imac:first-login-tour-seen:v1:fuqingxu', String(Date.now())); } catch(e){} // 关掉首登引导弹窗，否则盖住界面
}, TOKEN);
```
- **viewport 固定 1440×900 + deviceScaleFactor:2** → 截图 2880×1800，清晰；所有 CSS 坐标 ×2 = 图片像素。
- **`waitUntil: 'load'`，绝不用 `'networkidle'`**：Mobius 有 SSE 长连接，networkidle 永远不触发会 30s 超时（能继续但慢且状态不对）。

### 路由
- 项目：`/u/<user>/p/<project>`
- Issue：`/u/<user>/p/<project>/i/<issue>`
- 打开某个会话的聊天：`/u/<user>/p/<project>/i/<issue>?session=<session_id>`（IssuePage 右栏 `?session=` 时显示 ChatArea）
- 管理中心：点右上头像 → 管理中心（`[data-tour="top-user-menu"]` → 按钮「管理中心」），仅 admin 可见

### 截图 + 记录矩形（关键）
**用整页 viewport 截图 + 元素 `boundingBox()`**，矩形用 **CSS 像素**（与 annotate 的 SCALE=2 配套）：
```js
async function rect(loc){ const b = await loc.boundingBox(); return b && {x:b.x,y:b.y,w:b.width,h:b.height}; }
// 滚动目标入视口再截图
await page.locator('[data-tour="xxx"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${RAW}/01.png` });
```
- **弹窗/菜单点击用 `{force:true}`**：Mobius 的 `div.fixed.inset-0` 弹窗，普通 click 经常不触发（被遮罩拦截），`force:true` 才稳定。
- **等弹窗用稳定内层元素，别用 `div.fixed.inset-0` 的 locator visible**（Playwright 可见性判定对它不准）：
  ```js
  await page.waitForSelector('input[placeholder="搜索输入内容"]', { state:'visible' });
  ```
- **截图前等数据加载**：聊天历史/列表是 SSE 拉取的，`waitForTimeout(1500~2500)` 或 `waitForFunction(() => document.body.innerText.length > N)`。

把每张图的矩形写进 `shots.json`（见下一步）。

### 先探后截（probe → capture → fixup，省大量返工）
真实 UI 的选择器别靠猜——**先写个 probe 脚本**导航到目标页、dump 出所有可见交互元素（文本/title/aria/rect），看清楚再写正式 capture 脚本。矩形拿不准时，capture 脚本里把每步的 rect `console.log` 出来 + 先拍一张裸图，对照后再用 fixup 脚本补/改 `shots.json` 里的 highlight（比反复重跑 capture 快）。
```js
// dump 所有可见 button/a/input/label/select 的文本+矩形（写进 json 供查阅）
function dump(page,root){return page.evaluate((root)=>{const rc=el=>{const r=el.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};const vis=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>16&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden';};const el=root?document.querySelector(root):document;return Array.from((el||document).querySelectorAll('button,a,[role="button"],[role="tab"],input,label,select')).filter(vis).map(e=>({tag:e.tagName.toLowerCase(),txt:(e.textContent||'').trim().slice(0,30),title:e.getAttribute('title')||'',al:e.getAttribute('aria-label')||'',ph:e.getAttribute('placeholder')||'',checked:!!e.checked,rect:rc(e)}));},root);}
```

**坑① React 受控输入填不进去**：直接 `inp.value='x'` 不会更新 React state（提交时仍是空），必须用原生 setter 触发，或干脆用 Playwright 的 `page.fill(selector, value)`（最稳）：
```js
// page.fill 最稳：
await page.fill('input[placeholder="Research 标题"]','大模型推理加速');
// 或在 evaluate 内手动触发（React 认）：
const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
set.call(inp,'大模型推理加速'); inp.dispatchEvent(new Event('input',{bubbles:true}));
```

**坑② 按文本匹配会撞到同名元素**：Mobius 常有「侧栏导航按钮」和「弹窗内标签」同名（如 "Research Graph" 既是研究页侧栏按钮、又是团队弹窗里的 Agent 标签）。`.find(x=>x.textContent.includes(...))` 会命中**DOM 顺序靠前**的那个（侧栏），点下去没选中目标。**修法**：用更长、唯一的文本匹配（如 `/Research Graph 绘制/` 而非 `/Research Graph/`），或把查询 scope 到弹窗根（先给最高 z 的 `div.fixed.inset-0` 打 `data-topmodal` 标签再在其内 query）。

**坑③ 定位 select 时分清"包在里面"还是"平级"**：有的 label 把 `<select>` 包在里面（`<label>形象<select>…</select></label>`），有的是平级兄弟。取 select 时 `lab.querySelector('select')`（包在里面）vs `lab.parentElement.querySelector('select')`（平级）不一样，搞错会拿到隔壁那个 select（如把"场景"当成"形象"）。**先用 dump 确认结构，或直接按 options 内容反查**：`selects.find(s=>[...s.options].some(o=>/企鹅/.test(o.textContent)))`。

**别截出真实 Agent / 别烧 token**：截「创建 Agent / 启动会话」类弹窗时，**只展示配置、不要点「创建/启动/提交」**（一旦提交就 spawn 真实会话、烧模型 quota、污染数据）。截图停在表单填好未提交的状态即可；真要建演示数据，用最轻的 API（如建 research 只插一行 DB，不起 agent）。

---

## 2. PIL 标注（红色编号 + 描边 + 标签）

注意避免字体超出边框！这是标注阶段的常见错误

复用现成标注器 `.imac/tmp/tutorial05/annotate.py`（红圆角描边 + 编号红圆 badge + 白底红边 pill 标签 + leader line，CJK 自动换行 + 碰撞避让，字体 `/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc`）。

**它读 `shots.json`**（CSS 像素矩形，SCALE=2 乘回图片像素）：
```json
{
  "shot1": {
    "file": "01.png",
    "highlights": [
      {"rect": {"x":350,"y":537,"w":464,"h":96}, "anchor": "tr", "label": "① 这里是 XX 功能"}
    ]
  }
}
```
- `anchor`：badge 从元素的哪个角向外伸（`tl tr bl br tc bc cl cr`）。

**参数化复用**（annotate.py 把 RAW/OUT 写死了 tutorial05，复制一份改掉，或用环境变量）：
```bash
# 把 RAW/OUT 改成可环境变量覆盖
python3 - <<'PY'
src=open('.imac/tmp/tutorial05/annotate.py').read()
src=src.replace("RAW = '/home/tianyi/imac-test/.imac/tmp/tutorial05/raw'",
                "import os\nRAW = os.environ.get('TUT_RAW','/home/tianyi/imac-test/.imac/tmp/tutorial05/raw')")
src=src.replace("OUT = '/home/tianyi/imac-test/.imac/tmp/tutorial05/annotated'",
                "OUT = os.environ.get('TUT_OUT','/home/tianyi/imac-test/.imac/tmp/tutorial05/annotated')")
open('.imac/tmp/<yourdir>/annotate.py','w').write(src)
PY
TUT_RAW=/.../raw TUT_OUT=/.../annotated python3 .imac/tmp/<yourdir>/annotate.py
```

**聚焦裁剪**：整页截图里元素太小时，annotated 之后用 PIL 把关键区域裁出来（CSS 坐标 ×2）：
```python
from PIL import Image
im=Image.open('annotated/01.png')
im.crop((x0*2,y0*2,x1*2,y1*2)).thumbnail((1600,1600)).save('01_focus.jpg','JPEG',quality=88)
```

---

## 3. 上传图床

```bash
curl -X POST https://public.agent-matrix.com/up/v100 \
  -H "Authorization: Bearer iooir13gnwduio_beli882__AUNGLOIUYUG" \
  -F "folder=tutorial" -F "file_name=NN_topic_01.jpg" -F "file=@/path/to.jpg" --no-buffer
# 返回多行流式 JSON, 取 status==success 的 url
```

**硬规矩（都踩过）**：
- `folder` 必须**纯 ASCII 字母**（不能数字/连字符）→ 用 `tutorial`。
- **单文件限 ~500KB**。2880×1800 PNG 会 413 → 上传前 `Image.thumbnail((1600,1600))` + 存 **JPEG q88**（~150–250KB）。
- **`file_name` 扩展名必须与内容一致**：存 JPEG 字节就命名 `.jpg`（写 `.png` 会让 CDN 按 png 回头，类型不符）。
- **🔴 图床不覆盖同名**：同名重传，返回的 URL 服务的内容字节级不变（老图还在）。所以**每次用新文件名**（如加 `_v2`），改完同步改 markdown 里的 URL。这也意味着——**一旦截到密钥传上去了，删 markdown 没用，老 URL 仍可下载**，必须轮换密钥（见安全红线）。
- **域名漂移**：上传返回的 host 现在是 `serve.gptacademic.cn`（CDN），但 **docs 里必须用 `serve.nutshellai.cn`**（同 bucket 同 path，直接换 host，两域名都 200）。写 markdown 时直接把返回 URL 的 host 换掉：
  ```bash
  echo "$url" | sed 's#serve.gptacademic.cn#serve.nutshellai.cn#'
  ```

---

## 4. 写 markdown（双语）

- `docs/tutorial/NN_topic.md`（中文，主）+ `NN_topic.en.md`（英文）。
- **风格对齐 01–05**：极简。`#` 标题 + 编号步骤（`### 1.` `### 2.`），每步 1–3 行 bullet + 一张**带标记的截图**承载信息。
- 图片用图床绝对 URL：`![image](https://serve.nutshellai.cn/publish/auto/tutorial/NN_topic_01.jpg)`
- 末尾可加一句 `> 小贴士：...` 收尾。`‍`（零宽字符）当空行分隔，沿用旧教程习惯。

---

## 5. 改 mkdocs.yml + docs/index

mkdocs 用 **mkdocs-material + mkdocs-static-i18n**（`docs_structure: suffix`：文件名 `<name>.md`=默认中文，`<name>.en.md`=英文）。

### nav（英文 key + 子项）
```yaml
nav:
  - Home: index.md
  - 'II. Advanced Capabilities':
      - Add Remote Compute: tutorial/04_add_remote_server.md
```
- **section/章节名带冒号必须加引号**：`'Concepts: Skills & Memory': tutorial/...`，`nav_translations` 里同样 `"Concepts: Skills & Memory": ...`。
- 分区是顶层 dict + list 值（`navigation.sections` + `navigation.tabs` 已开，会渲染成分组/标签）。

### nav_translations（英文 key → 中文，zh 是默认语言）
```yaml
plugins:
  - i18n:
      docs_structure: suffix
      languages:
        - locale: zh
          default: true
          nav_translations:
            Home: 首页
            "II. Advanced Capabilities": II-高级能力
            "Add Remote Compute": 添加远程算力
```
- **每个 nav key（section 名 + 条目名）都必须在 nav_translations 里有对应中文**，漏一个中文站就显示英文。改完用脚本校验（见下）。

### docs/index.md / index.en.md（首页「快速开始」）
同步加一个 `### II-高级能力` 标题 + 链接列表，和 nav 分区一致。

---

## 6. 本地构建验证（务必做，CI 跑的是 `mkdocs build`）

仓库已备好专用 venv `.venv-docs`（mkdocs-material + mkdocs-static-i18n 都装好了），直接用：
```bash
.venv-docs/bin/mkdocs build --strict 2>&1 | tail -25
```
> 只有 `.venv-docs` 损坏 / 被删时才重建：`python3 -m venv .venv-docs && .venv-docs/bin/pip install -q -r docs/requirements-docs.txt`。
- 看日志有 `Translated N navigation elements to 'zh'`（N = nav key 总数，新增条目后 N 应 +对应数，无 missing）。
- 无 `error / Exception / Conflicting files`。
- **`--strict` 下任何 WARNING 都会 abort**：仓库里有长期存在的「非本次」告警（如未入库的 `compute-and-devices/README.*.md` 链接、`zhipu-key-setup.md` 未进 nav），它们与你的教程无关。**判断你自己的改动是否干净**：grep 构建输出里有没有 `tutorial/NN`、你的图床 URL、或你改的 nav key；再确认 `site/tutorial/` + `site/en/tutorial/` 下都生成了你的 `NN_*` 页面。只要这两条过了，strict 的 abort 就不是你造成的，可放行。
- **i18n 冲突**：`X.md`（默认 zh）和 `X.zh.md` 同时存在会报 `Conflicting files for the default language 'zh'`。修法：把英文内容从 `X.md` 改名到 `X.en.md`，留 `X.zh.md`（zh）+ `X.en.md`（en）。（注：默认 zh 用裸 `NN_xxx.md` 和显式 `NN_xxx.zh.md` 都合法，仓库里两种都有，保持和同分区已有教程一致即可。）

**一键校验 nav→翻译→文件 三者一致**：
```python
import yaml, os
d=yaml.safe_load(open('mkdocs.yml')); zt=d['plugins'][1]['i18n']['languages'][0]['nav_translations']
keys=[]
def walk(e):
    if isinstance(e,dict):
        for k,v in e.items():
            keys.append(k)
            if isinstance(v,list): [walk(x) for x in v]
for it in d['nav']: walk(it)
print('missing zh:', [k for k in keys if k not in zt])
# 每个 nav 条目都要有 .md 或 .zh.md (默认 zh) 源文件
```

验证完删掉 `site/` 和 venv（别提交构建产物）。

---

## 7. commit + push

```bash
git add -A   # 本仓库是自迭代项目: 按规则连非自己改的文件一并提交
git commit -m "Add tutorial: <英文说明> (中文说明, 含带标记截图; 同步 docs/index 与 mkdocs nav 中英)"
# GitLab（origin，内网，直连）
git push origin main
# GitHub（github，外网，TLS 常崩 → 走 proxychains；禁止用环境变量设代理）
proxychains -q git push github main
```
- commit message 格式：`英文 (中文)`，**不含人名**，邮箱 `mobius_os@163.com`（本仓库已配好）。
- **并发自迭代 agent 会 `git add -A`** 把你的改动扫进它的 commit（用它的 message）——你的代码会正确落入 HEAD，但若你要用自己的 message，提交要快。
- pre-commit hook 的 tsc/frontend 检查：只改 `.md`/`.yml` 时会 Skipped；偶尔首次 commit 报 "files were modified by this hook"（格式化），`git add -A && git commit` 再来一次即可。

---

## 🔴 安全红线（最重要）

**绝不能让密钥/token/私钥/真实凭据进入截图或教程文本。** 真实事故：tutorial 10 把 Claude Code 模型的 channel `key`（形如 `1d293dfd0a554fa381480f8828eba9f2.7f0EB6IaSjLtVi39`，是 token 形状）截进了管理中心截图，发布到了**公开**文档站。

截管理中心 / 模型配置 / 账号类页面前，**务必**：
1. **识别敏感字段**：模型 `key`、`api_key`、`token`、`Anthropic/Codex API Key`、SSH 私钥路径、密码框。注意模型 `key` 字段虽叫"key"，但值可能是 token（hex.secret 格式）。
2. **优先用掩码态截图**：表单的 api_key 默认就是掩码（`••••XXXX`）——别点"显示/揭示"按钮再截。
3. **不得不截含敏感值的区域 → 上传前用 PIL 马赛克/实色遮蔽该矩形**（重度像素化 + 高斯模糊，确保不可逆读）。
4. **密钥一旦传上图床 = 已泄露**：图床不删旧文件、文档站是公开的，必须**通知用户轮换密钥**，光删 markdown 没用。

同样**别写入真实账号密码 token 到 markdown 文本**。

---

## 关键常量速查

| 项 | 值 |
|---|---|
| Mobius 本地地址 | `http://127.0.0.1:45616` |
| 登录（密码免登） | `POST /api/auth/login {"username":"fuqingxu"}` → `.token` |
| 登录态 localStorage | `cc-token` |
| 关首登引导 localStorage | `imac:first-login-tour-seen:v1:fuqingxu` |
| Playwright | `NODE_PATH=$(find /home/tianyi/.npm/_npx -maxdepth 3 -name node_modules \| head -1)`（npx 缓存，别写死） |
| 标注器（复用源） | `.imac/tmp/tutorial05/annotate.py`（复制后参数化 RAW/OUT） |
| CJK 字体 | `/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc` |
| 图床上传 | `POST https://public.agent-matrix.com/up/v100`，`Authorization: Bearer iooir13gnwduio_beli882__AUNGLOIUYUG` |
| 图床 folder | `tutorial`（纯 ASCII 字母） |
| 图床域名（docs 用） | `serve.nutshellai.cn`（返回的是 `serve.gptacademic.cn`，换掉） |
| docs 仓库 | `/home/tianyi/imac-test`（`docs/` + `mkdocs.yml` + `docs/requirements-docs.txt`） |
| 远端 origin | `ssh://git@gitlab.agent-matrix.com:12340/nutshellai/mobius.git`（内网直连） |
| 远端 github | `https://github.com/nutshellai-tech/mobius.git`（外网，push 走 `proxychains -q`） |
| commit 邮箱/署名 | `mobius_os@163.com` / `Mobius OS`（已配） |

---

## 常见坑（别再踩）

- **`waitUntil:'networkidle'`** → SSE 永不空闲，30s 超时。用 `'load'` + 显式 wait。
- **弹窗 click 不触发** → 加 `{force:true}`；等弹窗用内层元素 `waitForSelector`，别用 `div.fixed.inset-0` 的 visible 判定。
- **整页截图元素太小** → annotated 后裁剪聚焦（CSS×2）。
- **图床同名不覆盖** → 永远用新文件名，改 md URL。
- **图床返回 `serve.gptacademic.cn`** → markdown 里必须换成 `serve.nutshellai.cn`，否则用户得手动 "discard cdn"。
- **mkdocs nav key 漏翻译** → 中文站显示英文；用上面的校验脚本查 missing。
- **`X.md` + `X.zh.md` 并存** → i18n 默认语言冲突，build 报错；把英文挪到 `X.en.md`。
- **GitHub push TLS 报错/超时** → 外网，走 `proxychains -q git push github main`；**禁止**用 `http_proxy` 环境变量。
- **截到密钥** → 见安全红线，必须遮蔽 + 通知轮换。
- **污染真实数据** → 用临时项目/示例记忆演示，做完删掉（`DELETE /api/projects/<id>` 带 `{"confirm":"<id>"}`）。
- **React 受控输入填不进** → `inp.value=` 不触发 React state；用 `page.fill()` 或原生 setter + `input` 事件（见 §1 坑①）。
- **按文本匹配撞同名** → 侧栏按钮与弹窗标签常同名（如 "Research Graph"）；用更长唯一文本或 scope 到弹窗根（见 §1 坑②）。
- **select 取错隔壁** → label 包 select vs 平级，搞错会拿到相邻 select；按 options 内容反查最稳（见 §1 坑③）。
- **截 Agent/会话创建弹窗误提交** → 只展示配置别点「创建/启动」，否则 spawn 真实会话烧 quota。
- **`--strict` 被「非本次」老告警 abort** → grep 自己的 `tutorial/NN` + 确认 `site/.../tutorial/NN_*` 生成即可放行（见 §6）。
- **新建分区只改了 nav** → 必须同步 nav_translations（section 名）+ index.md + index.en.md，三处缺一不可。
