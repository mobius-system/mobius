# 综合修改

- `mobius/frontend/src/components/chat.tsx` 的“项目知识沉淀到记忆”按钮与“查看当前知识”并排，位于其右侧，不再收纳在会话顶栏“更多操作”菜单中。
- 按钮发送的提示词要求先读取并合并已有知识：项目通用、跨任务可复用内容写入 `.imac/project_knowledge.md`，仅当前任务相关内容写入本 Issue 的 `issue_knowledge.md`；两者都要精简，避免重复、一次性过程、个人信息和凭据。
- `@` 智能体支持两种模式：`只读` 只把被 @ 智能体的上下文注入当前会话，不触发对端感知；`双向` 会给双方注入 curl 桥接提示，并通过 `/api/agent-bridge/messages` 做后续互发。
- `@` 的文件与智能体入口共用同一个抽屉，按标签页切换；输入框里直接输入 `@` 会打开该抽屉并复用同一条插入链路。

## 广告爽游实验室角色图集与打击特效（2026-08-07，v0.13.0）

- 角色 atlas 关闭 mipmap、使用 ClampToEdge + LinearFilter，避免无 padding SVG 图集在小尺寸实例上串帧；角色身份贴纸按题材切换材质并以稳定哈希控制普通角色展示密度。
- InstancedMesh 开启 `vertexColors`/`instanceColor` 时，平面几何必须补齐全白 `color` attribute，并把所有实例颜色初始化为白色；否则贴图会被乘成黑色剪影。
- 角色暗轮廓必须放在 billboard 后方（本项目相机朝负 Z 观察，轮廓 z 需略大于主体），不能只依赖 renderOrder；最终应同时验收僵尸与程序员题材，避免一题材纹理异步加载时误判。
- 命中/重击/暴击/击败特效沿用固定 burst/shockwave 对象池，按事件传递 `critical`/`heavy`/`variant`，保证高射速下反馈有层级且不产生运行期 Mesh 分配。

## 内置 Opus 在"模型接入"不可见/不可屏蔽 (已修 commit 18afdcb)
- 根因: `系统设置` 走 `modelRegistry.listSessionModelOptions()`(含内置), `模型接入` 走 `modelAccess.listClaudeCodeModels()`(只读表). 有 `seedBuiltinCodexIfNeeded` 无 claude 版, 内置 Opus 从不进表。
- 修法(对齐 codex): `model-access.ts` 加 `seedBuiltinClaudeIfNeeded` — 仅当 `~/.claude/mobiusdefault.settings.json` 存在时把 key=`mobiusdefault` seed 进 `claudeCodeModels`; `settingsFilenameForKey` 对该 key 特判成 `mobiusdefault.settings.json`(而非 `settings-<key>.json`), 与 model-registry 读取路径一致。`model-registry.ts` 读回 seed, 从 claudeDynamics 剔除避免重复, `enabled=false`→内置 Opus 从 picker+系统设置隐藏, 自定义 label 覆盖。
- 干净部署无该文件 → 不 seed 不显示。删除仍被 `admin.ts:1345` 挡("只能修改不能删"), 屏蔽靠取消"启用"。

## best-api: Qwen3.6-35B-A3B 链路故障排查 (2026-07-24)
- **现象**：cross_main solver 解「锐创科技并购对抗式尽职调查」的超重请求(4.6 万字/24 tools/max_tokens 32k)反复首 token 超时 → 504 → Anthropic SDK 死循环重试(12+ 次)
- **根因**：`Qwen3.6-35B-A3B` 被锁路由到故障的 `pai-35ba3b`(→:9001→beta client `190b7f00ee10`→远程 vLLM 间歇无响应，100s 首 token 超时)；该渠道还漏配 `sse_jump_client`、模型无 fallback
- **关键结论**：**dash(百炼)渠道的 `qwen3.6-35b-a3b` 完全可用(2s 级响应)**，可作 pai-35ba3b 的现成替代，无需重启远程实例
- **修复(待执行)**：① `MODEL_OVERRIDE.Qwen3.6-35B-A3B.MODEL_PROVIDER_RANK_OVERRIDE` 由 `["pai-35ba3b"]` 改 `["dash"]`；② `PROVIDER_OVERWRITE_MODEL_NAME.dash` 加 `"Qwen3.6-35B-A3B":"qwen3.6-35b-a3b"`(百炼认小写)；③ 重载 best-api 生效

## codex isWorking 间歇性误判 not working (2026-07-26, 已修 commit ec5a23b)
- **现象**：codex 通道 session 状态间歇性闪成"待命/not working"，实际 agent 仍在跑。
- **根因**：`backend/agents/tmux-codex.js` `_readWorkingFromJsonl` 只读尾部 64KB 反向扫标记(task_started/response_item/turn_context=working, task_complete=idle)。密集流式 `agent_message`/`token_count` 把本 turn 的 `task_started` 挤出 64KB 窗口 → 返回 `null` → 落到 `mtime<20s?working:entry.working`。codex 长思考/等慢 LLM 期间 rollout 常超 20s 无写入 → freshness 过期 → 回落 `entry.working`；后端重启后 `entry.working=false`(watcher 从末尾起读、错过本 turn 的 task_started) → 误判 not working。经 944 份真实 codex rollout 验证：64KB 窗口在 turn 进行中有 2035 处返回 null(误判险点)；task_complete 永远排在下个 task_started 前，故"窗口内 task_complete 误判 false"实测 0 次(不必担心收工误判)。
- **关键历史**：commit `d35b49c` 当年修的是**同一类 bug**(claude-code"卡片在流却卡待命"), 但只给 claude-code 把窗口 16KB→256KB, **codex 仅补了 freshness(20s)+2 个 marker, 窗口仍留 64KB** —— 即只修了一半, codex 这半一直没补。
- **修法(非 256KB, 远小于它)**：① `CODEX_WORKING_FRESH_MS` 20s→**60s**(覆盖思考间隙；收工 session 走 task_complete 早返回不经 freshness 分支, 不会误显 working); ② 窗口 64KB→**128KB**(把 null 处数 2035→1122; 单次 readSync 解析遇首个标记即停, 代价可忽略)。两步都必要且互补: freshness 治"思考间隙", 窗口治"流式挤标记"。
- **教训**：扩窗口是收益递减的创可贴(256KB 仍剩 565、512KB 仍剩 336 null), 真正杠杆是 freshness 阈值——null 分支里没有 task_complete 可见 ⟹ turn 未收工, freshness 在此唯一作用是覆盖思考间隙, 旧值 20s 太短。claude-code 同款 freshness 缺失, 若再现"卡片在流却卡待命"可同法补 freshness(而非继续加大窗口)。

## 简易/常规布局模式选择（2026-07-29）

- `layout_mode` 仅接受 `easy_mode` / `normal_mode`。`/u/:user`、Issue 无 session、Issue 带 session 三类入口在缺失或无效时显示不可关闭的选择弹窗；选简易模式跳转 `/u/:user/easy_mode`，选常规模式保留原路由。
- 主题菜单开关顺序固定为“背景光流 → 小莫光点 → 简易模式”；开启简易模式立即进入简易主页，关闭时写入 `normal_mode` 并从简易页返回用户主页。
- 模式选择卡必须说明“优势 / 适合 / 取舍”：常规模式强调层次化管理、群体技能/记忆、思考与工具细节、多项目并行；简易模式强调低认知负荷、传统 Agent 对话布局、专注 1–2 个项目。
- 选择弹窗的按钮会继承项目全局 `white-space: nowrap`；卡片必须显式设置 `whitespace-normal min-w-0 overflow-hidden`，并在桌面端与 390px 移动端验证 `scrollWidth <= clientWidth`。

## 广告爽游实验室难度平衡（2026-08-01，v0.8.2）

- 扩展位于 `mobius/extension/toy-toy-toy/`，保留 `zombie` 与 `deadline` 两套 10 关战役。难度校准不能只比较血量：至少同时计算各阶段来袭 HP/s、单路实际有效 DPS、算术门可获得的构筑倍率、漏怪容错和 Boss 到基地的击杀窗口。
- 高关原先无解的核心是敌人成长而基础装备每关重置、后期刷新池几乎全是精英、多炮台重复攻击同一小怪导致伤害溢出。最终规则为每关基础火力约 +5%、射速约 +4%，后期恢复杂兵为主/精英混编，多炮台在当前一路分摊普通目标，门和 Boss 仍集中齐射。
- Boss 指数最终为 `1.48^(level-1)`：zombie L1/L10 为 9,200/526,566 HP，deadline 为 8,125/478,673 HP；正确的 8 次左右算术选择可过，错误构筑仍可能在 Boss 前失败。旧 `1.72` 曲线令 L10/L1 约 221 倍，属于数学绝境。
- 算术门成功后回复 6% 基地并用选择冲击波清理标记的随车怪；打门主弹会穿透伤害护送怪。Boss 入场清场且停止刷小怪；濒死救场必须先于 `baseHp <= 0` 的失败结算执行。
- 平衡验收用 Electron 6× 自动策略跑中后期关卡，同时保留随机差构筑失败样本；最终验证两题材 L5/L8/L10 均存在通关样本，不能只靠静态公式或只跑第一关。

## 广告爽游实验室炮台与战斗特效（2026-08-02，v0.9.0）

- 僵尸炮台重画为城墙电磁歼灭炮，程序员炮台重画为移动 P0 救火车；弹丸分别从真实炮口和工单打印口发射，模型在固定俯视镜头下保持主体、身份与功能附件可辨识。
- 构筑效果必须直接反馈到模型：分裂、爆炸、连锁、冰冻、暴击和超载分别显示副武器、榴弹挂件、线圈/天线、冰晶/风扇、瞄准环/通过灯及高频脉冲；升级触发全队聚能束、地面扩散环、上升碎片和模型弹性反馈。
- 战斗特效按事件分级控制视觉密度：普通命中仅用轻量冲击环；重炮、暴击、爆炸升级、精英/Boss 击杀使用完整爆心、双层冲击波、主题碎片和多点连爆。高射速对象池应共享材质，避免为每枚弹丸重复创建材质。
- 零编译扩展修改 JS/CSS/素材后必须同步提升资源 `?v=` 并调用 rebuild；Electron 真实入口需分别验证两题材的枪口、弹道、升级附件、击杀/爆炸对象与控制台错误。

## 广告爽游实验室反馈链与挡板可读性（2026-08-02，v0.10.0）

- 炮台主角化不能只放大模型：单炮/少炮编队使用更大比例，多炮拉开横向间距；模型按构筑总量显示三级轮廓进化，切路增加倾斜与地面尾迹，升级文字避开主体。高构筑附件需压低自发光，防止叠加后过曝成白块。
- 开火反馈链按“后坐/枪口 → 题材弹道 → 敌人闪白、挤压、后仰 → 冲击/爆心 → 定向碎片 → 击杀音”闭环；暴击、精英和 Boss 才触发短重击停顿与屏闪。停顿必须按真实时间节流，避免高射速或高暴击率把游戏永久锁进慢动作。
- 挡板卡优先展示巨大公式、当前值到结果值、代价和剩余命中进度；长说明不在战场卡片重复。挡板展示色每轮从独立色池洗牌，只作为干扰项，与效果收益、风险和原始效果色无关。
- 僵尸弹种区分能量重炮、尸爆、连锁和冰晶组件；程序员弹种区分 BUG 工单、P0 事故、`@所有人`、需求冻结与 HOTFIX。音效分射击、主题命中、特殊弹种、击杀、切路、挡板击穿、升级和 Boss；高频噪声使用共享 AudioBuffer，禁止每发重新分配。
- Electron offscreen 连续帧验收需观察实际 impacts/criticalHits/specialImpacts/hitStops、挡板 resolve 和 AudioContext 状态；软件 WebGL 环境的 ReadPixels/GPU stall 属截图性能警告，不是业务错误。

## 广告爽游实验室电影化视觉系统（2026-08-02，v0.11.0）

- `frontend/visual-system.js` 独立拥有题材基地、炮台外装、角色身份配件、固定对象池 VFX、EffectComposer/Bloom/OutputPass 与视觉诊断；主玩法只通过事件钩子传入主题、敌人、基地生命、构筑和升级事件，避免视觉重构影响难度。
- 僵尸基地使用分段装甲墙、反应堆、探照灯和生命值驱动战损；程序员基地使用服务器机柜、部署门、状态灯和数据线缆。炮台外装从语义尺寸装配，并随 `evolutionStage`、射速和超载真实变化。
- 20 类角色身份配件使用确定性稀疏展示：精英/肉盾/Boss 必显，普通角色按稳定哈希约三分之一显示，避免密集尸潮/需求潮人人挂牌形成视觉噪声。
- 后处理顺序为 HDR 场景 → UnrealBloomPass → OutputPass（ACES 唯一 tone-map 所有者）；Bloom 只作高光增强，zombie/deadline 强度分别约 0.24/0.20、阈值 0.90/0.92，`noPost` 下主体轮廓和材质仍必须可辨。
- 爆炸与冲击环均改为固定复用池（24 个三层爆炸、36 个地面冲击环），爆炸碎片在每个池项内用 InstancedMesh 合批；运行期不再为每次命中临时创建/销毁 Three.js 材质和 Mesh。
- `window.__TOY_TOY_TOY_DEBUG__` 支持 `final/noPost/silhouette/material/emissive/vfx/bounds`、`near/design/far` 固定机位和 `low/balanced/high` 画质；快照暴露 DPR/像素预算、Bloom、角色配件实例、VFX 池占用、环境数量和 renderer 统计。1440×900 与 390×844 两题材连续帧验证均无控制台错误。

## 广告爽游实验室题材化声音系统（2026-08-02，v0.12.0）

- `frontend/audio-system.js` 独立管理 Web Audio：复用 13 组程序化瞬态/噪声缓冲，按 weapon/impact/feedback/ui/cinematic 分类混音，经压缩、硬限幅和短混响输出；Boss、升级、爆炸会 duck 普通射击与命中。
- zombie 使用炮膛低频、锈蚀机械、湿重命中、骨裂和碎片爆炸；deadline 使用键盘/打印机、纸张工单、盖章关闭、数字 glitch 和服务器告警。同一事件只共享语义，不共享单纯换频率的音色。
- 高频事件必须同时有事件 cooldown、分类 voice cap 和全局 cap；调试快照暴露事件计数、丢弃原因、活动 voice、音量总线和缓冲数量，`previewSound` 必须走真实声音系统。移动端保留声音开关，不可为腾 HUD 空间直接隐藏。

## 会话重命名后 AI 标题不再覆盖 (2026-08-05, commit 0977164)

- **问题**: 用户手动重命名会话后, AI 自动生成的标题 (claude-code 的 `type:ai-title` / codex 兜底生成器) 会反复覆盖用户起的名。根因: 后端没有"此 name 由用户钦定"的持久化标记, 前端创建表单的 `nameUserTouchedRef` 语义在会话创建时丢失。
- **方案**: 独立 DB 列 `sessions_v2.name_human_edited` (INTEGER NOT NULL DEFAULT 0), **不**用 name 末尾拼字符串 (那有 20+ 处渲染泄露面 + 重命名输入框会显示标记 + 破坏 startsWith 精确匹配)。列加在 `repositories/sessions.ts` 顶部幂等 IIFE (照搬 pc_client_metadata 模式)。
- **写入**: 重命名走 `Sessions.updateNameByUser` (置标记=1), AI 生成走原 `Sessions.updateName` (不动标记)。路由 `routes/sessions.ts:388` + `routes/tasks.ts:83` 的 PATCH 改用 updateNameByUser。创建表单手填名时前端 global-create.tsx 传 `name_touched`, 后端 issue 创建路由 (`routes/sessions.ts` issueScoped.post '/') 接收 → insert 时置标记。
- **跳过**: syncer (`session-title-syncer.ts`) 用 `findNameMetaById` 查标记, =1 早返回不覆盖; generator (`session-title-generator.ts` scanOnce) 同理 continue。
- **验证要点**: 开关 `autoGenerateSessionTitle.enabled` 默认 off 但本环境为 **true**; 验证 syncer 跳过逻辑必须确认开关开着 (否则 updated:false 是开关导致而非标记逻辑)。已验证: 标记=1→跳过, 标记=0→正常更新 (对照未误伤)。NewSessionModal 暂未接 name_touched (其 name 用户编辑度低, 留待以后)。

## 原生文件编辑器三栏布局与对话区可调宽（2026-08-07, commit 783755b）

- `code-conversation`（原生文件编辑器，顶栏第三个布局项）= IssuePage/ResearchPage 的三栏 flex 行：左文件树 `ResizablePanel(side=left)` + 中代码编辑器 + 右 `ChatArea`(flex-1)。改前中栏是 `flex-1`、与 ChatArea 各占一半且二者间无分隔条 → 对话区宽度锁死不可调（拖文件树只平移整体边界，对话区占比恒 50%）。
- 修法：把中栏代码编辑器也包成 `ResizablePanel`，**必须 `side="left"`**——手柄在该面板**右缘**（= 代码区｜对话区接缝，拖动即调对话区宽）。易踩坑：①误用 `side="right"` 会把手柄落到面板左缘（与文件树接缝重叠、调错边界）；②切勿条件包裹 `ChatArea` 来调宽——IssuePage 靠 ChatArea 兄弟索引恒定避免切布局时重挂（SSE/草稿/agent 状态全依赖不重挂），包裹即破坏该不变式。正确做法永远是改它的兄弟栏。storageKey `mobius:ui:split:cc-editor:<projectId>`，双击复位。
- 通用规则：mobius 多栏工作区给某栏加可调宽，把该栏包成 `ResizablePanel`，handle 总在该面板右缘（故都用 `side="left"`）；多栏都 `side="left"` 不冲突，各手柄落各自右缘。

## 广告爽游实验室正式游戏流程与高精度模型（2026-08-07，v0.14.0）

- 炮台/工位近景模型使用 `RoundedBoxGeometry`、高分段圆柱/圆环、炮身套环、散热鳍、铆钉与主题附件；角色身份贴纸 Canvas 提升到 512px（逻辑绘制坐标按 1.6 倍缩放），保留固定对象池特效。
- 低分辨率观感不只由几何段数造成：必须同时检查材质过曝、Bloom 和实际 DPR。v0.14 将 high 画质预算提升到 4.2M 像素（DPR 上限 2），并降低主灯/核心/屏幕自发光与 Bloom，避免炮台材质被白光吞掉；1440×900、deviceScaleFactor 2 实测 DPR 约 1.8、无页面错误。
- 暂停菜单应提供继续、重开当前关、选择关卡、切换题材、退出本局返回标题；暂停时展示当前关卡、得分、击杀和基地状态。移动端用单列动作按钮，390×844 实测菜单卡与四个按钮均未溢出。
- 正式流程回归需验证 `playing → paused → menu → level select → playing`、重开保持所选关卡、退出返回标题，以及切换 zombie/deadline 后重新开始；零编译扩展每次资源版本提升后必须 `POST /api/extensions/toy-toy-toy/rebuild`。
