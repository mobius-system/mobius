/**
 * session-context-sections.ts — 首轮注入上下文的文本块目录 (零依赖, 前后端共用).
 *
 * 每个文本块 = 一个独立的 defineSection 常量: 标题 (zh/en) + 由标题派生的整行匹配正则 +
 * 中英两个构建器, 全部内聚在同一对象里, 块与块之间零引用。改一个块只动它自己的 const。
 *
 *  - 生成侧: services/session-context.ts 的 formatBody 按 SESSION_SECTIONS 顺序逐块 build,
 *    段间统一 '\n\n' 连接 (个别块用 tightNext / doubleGap 复刻历史格式, 见各块注释)。
 *  - 匹配侧: 前端 viewer/initial-context.ts import 本文件, 用同一份 title/pattern 做
 *    「有序锚点扫描」把历史会话里的初始消息切块渲染 (初始卡片)。标题与正则同源派生,
 *    生成器改文案后正则自动跟随, 不存在两处维护。
 *
 * 约束: 本文件除类型外禁止任何 import (不碰 fs/db/config), 保证浏览器端可直接打包。
 */

// ── md: f-string + dedent 的 tagged template ──────────────────────────────
// 模板里可以按代码缩进书写, 输出自动剥掉静态行的公共缩进; 首尾空行清理;
// 「整行只有一个插值且值为空」的行整行折叠 (条件字段不残留空行)。
// 插值展开的内容不参与缩进计算也不被剥缩进 (替换发生在剥缩进之后), indent() 的两空格原样保留。
const SENTINEL = '\u0000';

export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  const sentinelOf = (i: number) => `${SENTINEL}${i}${SENTINEL}`;
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? sentinelOf(i) : ''), '');
  const sentinelRe = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');
  const lines = text.split('\n');
  // 公共缩进: 统计「纯空白行」以外所有行的前导空白 (含插值宿主行 —— 宿主缩进就是代码缩进)。
  let commonIndent = Infinity;
  for (const line of lines) {
    if (!line.replace(sentinelRe, '').trim() && !sentinelRe.test(line)) continue;
    sentinelRe.lastIndex = 0;
    commonIndent = Math.min(commonIndent, line.match(/^[ \t]*/)![0].length);
  }
  if (!Number.isFinite(commonIndent)) commonIndent = 0;
  const stripped = lines.map((line) => line.slice(Math.min(commonIndent, line.match(/^[ \t]*/)![0].length)));
  // 空插值整行折叠: 行内只有哨兵 + 空白, 且所有对应值都为空白 → 删行
  const collapsed: string[] = [];
  for (const line of stripped) {
    const ids = [...line.matchAll(sentinelRe)].map((m) => Number(m[1]));
    const hasStatic = line.replace(sentinelRe, '').trim().length > 0;
    if (!hasStatic && ids.length > 0 && ids.every((id) => !String(values[id] ?? '').trim())) continue;
    collapsed.push(line.replace(sentinelRe, (_full: string, id: string) => String(values[Number(id)] ?? '')));
  }
  // 去首尾空行
  while (collapsed.length > 0 && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed.join('\n');
}

function indent(text: unknown, prefix = '  '): string {
  return String(text || '').split('\n').map((l) => prefix + l).join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 块定义 ────────────────────────────────────────────────────────────────

export interface SectionEnv {
  port: number | string;
  hiddenFolderName: string;
  skillsSubdir: string;
}

// 构建器上下文: gather 出的 sources 原样 + formatBody 注入的服务端预计算字段。
// 注入字段的存在让本文件的 build 保持纯函数 (同样的 ctx → 同样的文本)。
export interface SectionCtx {
  user?: any;
  project?: any;
  issue?: any;
  research?: any;
  session?: any;
  skills?: any[];
  memories?: any[];
  research_peers?: any[];
  language?: 'zh' | 'en';
  env?: SectionEnv;
  builtin_memories?: any[];
  blackboard_session_token?: string;
  blackboard_token_header?: string;
  chief_team_token?: string;
  team_token_header?: string;
  worktree_is_repo_root?: boolean;
  pc_task_mode_prompt_zh?: string;
  pc_task_mode_prompt_en?: string;
  session_is_assistant?: boolean;
  [key: string]: any;
}

export interface SectionTitles {
  zh: string;
  en: string;
  zhAlt?: string;
  enAlt?: string;
}

export type SectionBuild = (c: SectionCtx, t: SectionTitles) => string | null;

export interface SectionDef {
  key: string;
  title: SectionTitles;
  build: { zh: SectionBuild; en: SectionBuild };
  // 本块与前一块的连接符 (默认 '\n\n')。tightNext='\n' 复刻旧版 completionFlag 与
  // Issue/Session 段之间无空行的历史格式; doubleGap='\n\n\n' 复刻 pcTaskMode 段前双空行。
  tightNext?: boolean;
  doubleGap?: boolean;
  pattern: { zh: RegExp; en: RegExp };
}

function titlePattern(titles: SectionTitles, lang: 'zh' | 'en'): RegExp {
  const primary = titles[lang];
  const alt = lang === 'zh' ? titles.zhAlt : titles.enAlt;
  const body = alt ? `${escapeRegExp(primary)}|${escapeRegExp(alt)}` : escapeRegExp(primary);
  return new RegExp(`^(?:${body})$`, 'm');
}

export function defineSection(def: Omit<SectionDef, 'pattern'>): SectionDef {
  return {
    ...def,
    pattern: {
      zh: titlePattern(def.title, 'zh'),
      en: titlePattern(def.title, 'en'),
    },
  };
}

// ── 各文本块 (每块一个 const, 互不引用) ────────────────────────────────────

const ISSUE_STATUS_LABELS: Record<string, string> = { active: '开放', in_progress: '进行中', completed: '已解决', open: '开放' };
const RESEARCH_STATUS_LABELS: Record<string, string> = { active: '开放', completed: '已完成' };
const SESSION_STATUS_LABELS: Record<string, string> = { active: '进行中', archived: '已归档', completed: '已完成' };
const ISSUE_STATUS_LABELS_EN: Record<string, string> = { active: 'Open', in_progress: 'In Progress', completed: 'Resolved', open: 'Open' };
const RESEARCH_STATUS_LABELS_EN: Record<string, string> = { active: 'Open', completed: 'Completed' };
const SESSION_STATUS_LABELS_EN: Record<string, string> = { active: 'In Progress', archived: 'Archived', completed: 'Completed' };

export const HeaderSection = defineSection({
  key: 'header',
  title: {
    zh: '以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.',
    en: 'The following describes the user you are assisting, and the Project, Issue/Research, and Session this work belongs to.',
  },
  build: {
    zh: (_c, t) => t.zh,
    en: (_c, t) => md`
      ${t.en}
      Use it to calibrate how you address the user and the scope of your work; do not ask for fields already listed here.
    `,
  },
});

export const UserSection = defineSection({
  key: 'user',
  title: { zh: '## 用户', en: '## User' },
  build: {
    zh: (c, t) => !c.user ? null : md`
      ${t.zh}
      - 姓名: ${c.user.display_name || c.user.id}
      - 角色: ${c.user.role === 'admin' ? '管理员' : c.user.role === 'developer' ? '开发者' : '成员'}
      - 倾向语言: 中文
    `,
    en: (c, t) => !c.user ? null : md`
      ${t.en}
      - Name: ${c.user.display_name || c.user.id}
      - Role: ${c.user.role === 'admin' ? 'Admin' : c.user.role === 'developer' ? 'Developer' : 'Member'}
      - Language Preference: English
    `,
  },
});

export const ProjectSection = defineSection({
  key: 'project',
  title: { zh: '## 项目', en: '## Project' },
  build: {
    zh: (c, t) => !c.project ? null : md`
      ${t.zh}
      - 名称: ${c.project.name}
      ${c.project.description ? `- 描述:\n${indent(c.project.description)}` : ''}
    `,
    en: (c, t) => !c.project ? null : md`
      ${t.en}
      - Name: ${c.project.name}
      ${c.project.description ? `- Description:\n${indent(c.project.description)}` : ''}
    `,
  },
});

export const ResearchSection = defineSection({
  key: 'research',
  title: { zh: '## Research', en: '## Research' },
  build: {
    zh: (c, t) => !c.research ? null : md`
      ${t.zh}
      - ID: ${c.research.id}
      - 标题: ${c.research.title}
      - 状态: ${RESEARCH_STATUS_LABELS[c.research.status] || c.research.status || '未知'}
      ${c.research.description ? `- 描述:\n${indent(c.research.description)}` : ''}
    `,
    en: (c, t) => !c.research ? null : md`
      ${t.en}
      - ID: ${c.research.id}
      - Title: ${c.research.title}
      - Status: ${RESEARCH_STATUS_LABELS_EN[c.research.status] || c.research.status || 'Unknown'}
      ${c.research.description ? `- Description:\n${indent(c.research.description)}` : ''}
    `,
  },
});

function researchBlackboardUrl(c: SectionCtx): string {
  return `http://localhost:${c.env?.port}/api/research-blackboard/${c.research.id}`;
}

export const BlackboardSection = defineSection({
  key: 'blackboard',
  title: { zh: '## Research Blackboard', en: '## Research Blackboard' },
  build: {
    zh: (c, t) => {
      if (!(c.research && c.research.id)) return null;
      const url = researchBlackboardUrl(c);
      const sessionId = c.session?.session_id && c.session.session_id !== '(待创建)' ? c.session.session_id : '';
      const sessionToken = c.blackboard_session_token || '';
      const author = c.session?.research_role || 'research_assistant';
      return md`
        ${t.zh}
        当前研究的 Blackboard 只能通过 Mobius HTTP API 读写。不要直接编辑 \`${c.env?.hiddenFolderName}/blackboard/${c.research.id}/blackboard.jsonl\` 文件。

        读取完整 Blackboard:

        \`\`\`bash
        ${`curl${sessionToken ? ` -H '${c.blackboard_token_header}: ${sessionToken}'` : ''} ${url}`}
        \`\`\`

        写入 Blackboard:

        \`\`\`bash
        ${`curl -X POST ${url} \\`}
        ${`  -H 'Content-Type: application/json' \\`}
        ${sessionToken ? `  -H '${c.blackboard_token_header}: ${sessionToken}' \\` : ''}
        ${`  -d '{"author":"${author}${sessionId ? ` (${sessionId})` : ''}","session_id":"${sessionId}","content":"这里写入你的研究进展、发现或需要同步给团队的信息"}'`}
        \`\`\`

        Blackboard 内容只记录写入者和内容，不指定接收者。任意写入都会在后台投递给本 Research 中其他已创建 session。
      `;
    },
    en: (c, t) => {
      if (!(c.research && c.research.id)) return null;
      const url = researchBlackboardUrl(c);
      const sessionId = c.session?.session_id && c.session.session_id !== '(待创建)' ? c.session.session_id : '';
      const sessionToken = c.blackboard_session_token || '';
      const author = c.session?.research_role || 'research_assistant';
      return md`
        ${t.en}
        This research's Blackboard can only be read and written through the Mobius HTTP API. Do not directly edit the \`${c.env?.hiddenFolderName}/blackboard/${c.research.id}/blackboard.jsonl\` file.

        Read the full Blackboard:

        \`\`\`bash
        ${`curl${sessionToken ? ` -H '${c.blackboard_token_header}: ${sessionToken}'` : ''} ${url}`}
        \`\`\`

        Write to the Blackboard:

        \`\`\`bash
        ${`curl -X POST ${url} \\`}
        ${`  -H 'Content-Type: application/json' \\`}
        ${sessionToken ? `  -H '${c.blackboard_token_header}: ${sessionToken}' \\` : ''}
        ${`  -d '{"author":"${author}${sessionId ? ` (${sessionId})` : ''}","session_id":"${sessionId}","content":"Write your research progress, findings, or anything to sync with the team here"}'`}
        \`\`\`

        A Blackboard entry records only its author and content, with no designated recipient. Any write is delivered in the background to the other sessions already created in this Research.
      `;
    },
  },
});

export const ChiefSection = defineSection({
  key: 'chief',
  title: { zh: '## Chief 团队管理能力', en: '## Chief team-management capability' },
  build: {
    zh: (c, t) => {
      if (!(c.research && c.research.id && c.session?.research_role === 'chief_researcher' && c.session?.session_id && c.research?.mode === 'chief_led')) return null;
      const teamUrl = `http://localhost:${c.env?.port}/api/researches/${c.research.id}/team`;
      return md`
        ${t.zh}
        - 当前 Assistant limit: ${c.research.assistant_limit || 3}（Chief 不占名额，且你不能修改 limit）
        - 只有在用户明确授权后才能招募 Assistant；能由现有成员完成时不要扩编。
        - 招募前必须说明现有团队为什么无法完成、缺少什么能力、预期产出是什么。
        - 删除 Agent 必须提供删除理由和未完成任务交接；你不能创建或删除 Chief。
        - 查询团队: GET ${teamUrl}
        - 创建 Assistant: POST ${teamUrl}/agents
        - 移除 Assistant: DELETE ${teamUrl}/agents/<session_id>
        - 请求头: ${c.team_token_header}: ${c.chief_team_token}
        - 创建请求必填: name, purpose, model, skill_ids, memory_ids, memory_selection_confirmed=true, initial_prompt, recruit_reason, expected_outcome, request_id，以及按钮 authorization_id 或自然语言 authorization_quote。
      `;
    },
    en: (c, t) => {
      if (!(c.research && c.research.id && c.session?.research_role === 'chief_researcher' && c.session?.session_id && c.research?.mode === 'chief_led')) return null;
      const teamUrl = `http://localhost:${c.env?.port}/api/researches/${c.research.id}/team`;
      return md`
        ${t.en}
        - Current Assistant limit: ${c.research.assistant_limit || 3}; the Chief does not count and cannot change it.
        - Recruit only after explicit user authorization and record why the current team cannot do the work.
        - Removing an Agent requires a reason and unfinished-work handoff. You cannot create or remove a Chief.
        - Team state: GET ${teamUrl}
        - Recruit Assistant: POST ${teamUrl}/agents
        - Remove Assistant: DELETE ${teamUrl}/agents/<session_id>
        - Header: ${c.team_token_header}: ${c.chief_team_token}
      `;
    },
  },
});

export const PeersSection = defineSection({
  key: 'peers',
  title: { zh: '## 已有 Research Sessions', en: '## Existing Research Sessions' },
  build: {
    zh: (c, t) => {
      if (!Array.isArray(c.research_peers) || c.research_peers.length === 0) return null;
      return md`
        ${t.zh}
        ${c.research_peers.map((p) => `- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`).join('\n')}
      `;
    },
    en: (c, t) => {
      if (!Array.isArray(c.research_peers) || c.research_peers.length === 0) return null;
      return md`
        ${t.en}
        ${c.research_peers.map((p) => `- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`).join('\n')}
      `;
    },
  },
});

function memoryItems(c: SectionCtx): any[] {
  return [...(c.builtin_memories || []), ...(Array.isArray(c.memories) ? c.memories : [])];
}

// 单条记忆的行序列, 与旧版逐 push 对齐:
// `### 名` ["> 描述"] '' body '' (['---' ''] 仅非末条)
function memoryLines(m: any, isLast: boolean): string[] {
  const lines: string[] = [`### ${m.name}`];
  if (m.description) lines.push(`> ${m.description}`);
  lines.push('');
  lines.push(String(m.body || '').replace(/\r\n/g, '\n').trimEnd());
  lines.push('');
  if (!isLast) {
    lines.push('---');
    lines.push('');
  }
  return lines;
}

function knowledgeHintLines(c: SectionCtx, lang: 'zh' | 'en'): string[] {
  if (!(c.project && c.project.bind_path)) return [];
  const pkPath = `${c.project.bind_path}/${c.env?.hiddenFolderName}/project_knowledge.md`;
  const ikPath = (c.issue && c.issue.id)
    ? `${c.project.bind_path}/${c.env?.hiddenFolderName}/issue_knowledge/${c.issue.id}/issue_knowledge.md`
    : '';
  if (ikPath) {
    return lang === 'zh' ? [
      '此外，如果需要记住一些信息供未来使用，请写入对应的知识文件（不要写入 ~/.codex 或 ~/.claude）：',
      `- 如果是项目通用知识（整体事实、通用做法、跨任务可复用的经验，写入 project_knowledge 的内容务必非常非常精简、克制）→ \`${pkPath}\`；`,
      `- 如果是仅与当前任务相关、通用性有限的知识，写入 issue_knowledge（简洁、不要废话） → \`${ikPath}\`；`,
    ] : [
      'Additionally, if you need to remember information for future sessions, write it to the appropriate knowledge file (do not write to ~/.codex or ~/.claude):',
      `- For project-wide general knowledge (overall facts, common practices, cross-task reusable experience; keep what you write into project_knowledge concise and restrained) → \`${pkPath}\`;`,
      `- For knowledge relevant only to the current task with limited generality, write to issue_knowledge → \`${ikPath}\`;`,
    ];
  }
  return lang === 'zh' ? [
    `此外，如果需要记住一些信息供未来使用，请写入 ${c.project.bind_path}/${c.env?.hiddenFolderName}/project_knowledge.md，不要写入 ~/.codex 或者 ~/.claude。`,
  ] : [
    `Additionally, if you need to remember information for future sessions, please write to ${c.project.bind_path}/${c.env?.hiddenFolderName}/project_knowledge.md, do not write to ~/.codex or ~/.claude.`,
  ];
}

export const MemorySection = defineSection({
  key: 'memory',
  title: { zh: '## 持久 Memory', en: '## Persistent Memory' },
  build: {
    zh: (c, t) => {
      const all = memoryItems(c);
      if (all.length === 0) return null;
      const lines: string[] = [t.zh, '本用户与项目积累的长期事实 / 偏好如下. 视作已知信息.', ''];
      all.forEach((m, idx) => lines.push(...memoryLines(m, idx === all.length - 1)));
      lines.push(...knowledgeHintLines(c, 'zh'));
      return lines.join('\n').replace(/\n$/, '');
    },
    en: (c, t) => {
      const all = memoryItems(c);
      if (all.length === 0) return null;
      const lines: string[] = [t.en, 'Long-term facts / preferences accumulated for this user and project are listed below. Treat them as known information.', ''];
      all.forEach((m, idx) => lines.push(...memoryLines(m, idx === all.length - 1)));
      lines.push(...knowledgeHintLines(c, 'en'));
      return lines.join('\n').replace(/\n$/, '');
    },
  },
});

export const SkillsSection = defineSection({
  key: 'skills',
  title: { zh: '## 必要 Skill', en: '## Required Skills' },
  build: {
    zh: (c, t) => {
      if (!c.skills || c.skills.length === 0) return null;
      const lines: string[] = [t.zh, '以下Skill与当前问题可能有关，在解决问题之前，你必须根据实际需要，有选择性地理解并学习以下skill', ''];
      for (const sk of c.skills) {
        lines.push(`- **${sk.name}**`);
        lines.push(`  - 路径: \`${sk.dirName ? `${c.env?.skillsSubdir}/${sk.dirName}/SKILL.md` : '(未知路径)'}\``);
        if (sk.description) lines.push(`  - 简介: ${sk.description}`);
      }
      return lines.join('\n');
    },
    en: (c, t) => {
      if (!c.skills || c.skills.length === 0) return null;
      const lines: string[] = [t.en, 'Before solving the problem, you can read and learn the following skills according to your need.', ''];
      for (const sk of c.skills) {
        lines.push(`- **${sk.name}**`);
        lines.push(`  - Path: \`${sk.dirName ? `${c.env?.skillsSubdir}/${sk.dirName}/SKILL.md` : '(unknown path)'}\``);
        if (sk.description) lines.push(`  - Summary: ${sk.description}`);
      }
      return lines.join('\n');
    },
  },
});

export const WorktreeSection = defineSection({
  key: 'worktree',
  title: {
    zh: '## Git Worktree 工作区 (必读, 任务开始前优先执行)',
    en: '## Git Worktree Workspace (must read, do this first before starting the task)',
    zhAlt: '## Git Worktree 设置',
    enAlt: '## Git Worktree Setup',
  },
  build: {
    zh: (c, t) => {
      const wt = (c.issue && c.issue.use_worktree && c.project && c.project.bind_path)
        ? { root: c.project.bind_path, branch: c.issue.worktree_branch }
        : null;
      if (!wt) return null;
      if (!c.worktree_is_repo_root) {
        return md`
          ${t.zhAlt}
          本 Issue 勾选了 git worktree，但项目绑定路径 \`${wt.root}\` 当前不是 Git 仓库根。平台已忽略 git worktree 选项。
          请直接在普通工作目录 \`${wt.root}\` 内完成任务，不要创建或切换 git worktree。
        `;
      }
      const wtPath = `${wt.root}/${wt.branch}`;
      return md`
        ${t.zh}
        本 Issue 启用 git worktree. 仓库根: \`${wt.root}\` ; 你的工作区: \`${wtPath}\` (分支 \`${wt.branch}\`).
        平台只创建了该路径下的空占位目录, **真正的 git worktree 需要你来创建**.

        ### 第一步 (任何任务动作之前)
        在仓库根把占位目录初始化为 git worktree, 创建并检出分支, 然后进入工作区:

        \`\`\`bash
        ${`cd "${wt.root}"`}
        ${`rm -rf "${wtPath}"   # 平台占位空目录; git worktree add 不接受已存在目录`}
        ${`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`}
        ${`  || git worktree add "${wtPath}" "${wt.branch}"   # 分支已存在则复用`}
        ${`cd "${wtPath}"`}
        \`\`\`

        此后所有代码改动都在该 worktree 内进行. (备注：可能存在不止一个git仓库，请随机应变）

        ${c.session_is_assistant ? '### 任务完成时 (成功或失败)' : '### 任务完成时 (成功或失败, 在删除下方 running.flag 之前必须做)'}
        ${`把分支 \`${wt.branch}\` 合并到 \`agent_smart_dev\` 分支:`}

        \`\`\`bash
        ${`cd "${wtPath}"`}
        ${`git add -A && git commit -m "task: ${wt.branch}" || true`}
        ${`cd "${wt.root}"`}
        git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev
        git checkout agent_smart_dev
        ${`git merge "${wt.branch}"`}
        \`\`\`

        若合并有冲突, 必须解决全部冲突后再完成合并; 合并完成后重新运行测试验证需求是否满足. 若仍有冲突或测试不通过, 继续修复 → 重新合并 → 重新测试, **直到没有冲突且测试通过为止**.
        一切结束后，尝试git push，如果因为认证，失败了也没关系，跳过即可。
        ${!c.session_is_assistant ? `提示: running.flag 位于仓库根 \`${wt.root}/${c.env?.hiddenFolderName}/...\`, 不在 worktree 内 — 重建/删除 worktree 目录时不要误删它.` : ''}
      `;
    },
    en: (c, t) => {
      const wt = (c.issue && c.issue.use_worktree && c.project && c.project.bind_path)
        ? { root: c.project.bind_path, branch: c.issue.worktree_branch }
        : null;
      if (!wt) return null;
      if (!c.worktree_is_repo_root) {
        return md`
          ${t.enAlt}
          This Issue enabled git worktree, but the project bind path \`${wt.root}\` is currently not a Git repository root. The platform has ignored the git worktree option.
          Please complete the task directly in the normal working directory \`${wt.root}\`; do not create or switch git worktrees.
        `;
      }
      const wtPath = `${wt.root}/${wt.branch}`;
      return md`
        ${t.en}
        This Issue enables git worktree. Repo root: \`${wt.root}\` ; your workspace: \`${wtPath}\` (branch \`${wt.branch}\`).
        The platform only created an empty placeholder directory at that path; **you must create the actual git worktree yourself**.

        ### Step 1 (before any task action)
        In the repo root, initialize the placeholder directory as a git worktree, create and check out the branch, then enter the workspace:

        \`\`\`bash
        ${`cd "${wt.root}"`}
        ${`rm -rf "${wtPath}"   # platform placeholder empty dir; git worktree add does not accept an existing directory`}
        ${`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`}
        ${`  || git worktree add "${wtPath}" "${wt.branch}"   # reuse the branch if it already exists`}
        ${`cd "${wtPath}"`}
        \`\`\`

        From now on, make all code changes inside this worktree. (Note: there may be more than one git repo, so adapt as needed.)

        ${c.session_is_assistant ? '### When the task is done (success or failure)' : '### When the task is done (success or failure, must do this before deleting the running.flag below)'}
        ${`Merge branch \`${wt.branch}\` into the \`agent_smart_dev\` branch:`}

        \`\`\`bash
        ${`cd "${wtPath}"`}
        ${`git add -A && git commit -m "task: ${wt.branch}" || true`}
        ${`cd "${wt.root}"`}
        git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev
        git checkout agent_smart_dev
        ${`git merge "${wt.branch}"`}
        \`\`\`

        If the merge has conflicts, you must resolve all of them before completing the merge; after merging, re-run the tests to verify the requirements are met. If conflicts remain or tests fail, keep fixing → re-merging → re-testing, **until there are no conflicts and the tests pass**.
        When everything is done, try git push; if it fails due to authentication, that is fine, just skip it.
        ${!c.session_is_assistant ? `Note: running.flag lives at the repo root \`${wt.root}/${c.env?.hiddenFolderName}/...\`, not inside the worktree — do not accidentally delete it when rebuilding/removing the worktree directory.` : ''}
      `;
    },
  },
});

// tightNext: 复刻旧版 —— completionFlag 段尾不带空行, 其后的 Issue/Session 段紧跟 (段间零空行)
export const CompletionFlagSection = defineSection({
  key: 'completionFlag',
  title: { zh: '## 当任务完成时的最后一步', en: '## Final step when the task is complete' },
  tightNext: true,
  build: {
    zh: (c, t) => {
      if (!(c.session && c.session.session_id && c.session.session_id !== '(待创建)')) return null;
      if (c.session_is_assistant) return null;
      const flagRoot = c.project?.bind_path ? c.project.bind_path : '.';
      const flagPath = `${flagRoot}/${c.env?.hiddenFolderName}/flags/${c.session.session_id}/running.flag`;
      return md`
        ${t.zh}
        当任务最终成功或者最终失败时，你需要删除标记文件 ${flagPath}。但是，不要轻易放弃，尝试一切可能解决问题的方法，直到你确信无法继续为止。
        每当用户提出新问题新指令时，都会创建新的running.flag。
      `;
    },
    en: (c, t) => {
      if (!(c.session && c.session.session_id && c.session.session_id !== '(待创建)')) return null;
      if (c.session_is_assistant) return null;
      const flagRoot = c.project?.bind_path ? c.project.bind_path : '.';
      const flagPath = `${flagRoot}/${c.env?.hiddenFolderName}/flags/${c.session.session_id}/running.flag`;
      return md`
        ${t.en}
        When the task ultimately succeeds or ultimately fails, you must delete the marker file ${flagPath}. But do not give up easily — try every possible way to solve the problem until you are convinced you cannot continue.
        When user gives new instruction again, running.flag will be recreated.
      `;
    },
  },
});

export const IssueSection = defineSection({
  key: 'issue',
  title: { zh: '## Issue', en: '## Issue' },
  build: {
    zh: (c, t) => !c.issue ? null : md`
      ${t.zh}
      - 标题: ${c.issue.title}
      - 状态: ${ISSUE_STATUS_LABELS[c.issue.status] || c.issue.status || '未知'}
      ${c.issue.description ? `- 描述:\n${indent(c.issue.description)}` : ''}
    `,
    en: (c, t) => !c.issue ? null : md`
      ${t.en}
      - Title: ${c.issue.title}
      - Status: ${ISSUE_STATUS_LABELS_EN[c.issue.status] || c.issue.status || 'Unknown'}
      ${c.issue.description ? `- Description:\n${indent(c.issue.description)}` : ''}
    `,
  },
});

export const SessionSection = defineSection({
  key: 'session',
  title: { zh: '## Session', en: '## Session' },
  build: {
    zh: (c, t) => !c.session ? null : md`
      ${t.zh}
      - 名称: ${c.session.name}
      - 状态: ${SESSION_STATUS_LABELS[c.session.status] || c.session.status || '未知'}
      ${c.session.research_role ? `- 角色: ${c.session.research_role}` : ''}
      ${c.session.description ? `- 描述:\n${indent(c.session.description)}` : ''}
    `,
    en: (c, t) => !c.session ? null : md`
      ${t.en}
      - Name: ${c.session.name}
      - Status: ${SESSION_STATUS_LABELS_EN[c.session.status] || c.session.status || 'Unknown'}
      ${c.session.research_role ? `- Research Role: ${c.session.research_role}` : ''}
      ${c.session.description ? `- Description:\n${indent(c.session.description)}` : ''}
    `,
  },
});

// doubleGap: 复刻旧版 —— pcTaskMode 段以 '\n## ' 开头, 与前段之间形成双空行
export const PcTaskModeSection = defineSection({
  key: 'pcTaskMode',
  title: { zh: '## PC/Terminal 任务模式', en: '## PC/Terminal Task Mode' },
  doubleGap: true,
  build: {
    zh: (c, t) => {
      const prompt = c.pc_task_mode_prompt_zh;
      return prompt ? md`
        ${t.zh}

        ${prompt}
      ` : null;
    },
    en: (c, t) => {
      const prompt = c.pc_task_mode_prompt_en;
      return prompt ? md`
        ${t.en}

        ${prompt}
      ` : null;
    },
  },
});

// 拼装顺序 (同时是前端有序锚点扫描的边界顺序)。question 不在此列 —— 它由 wrapUserMessage
// 在 body 之后追加, 前端扫描时作为最后一个锚点单独消费。
export const SESSION_SECTIONS: SectionDef[] = [
  HeaderSection,
  UserSection,
  ProjectSection,
  ResearchSection,
  BlackboardSection,
  ChiefSection,
  PeersSection,
  MemorySection,
  SkillsSection,
  WorktreeSection,
  CompletionFlagSection,
  IssueSection,
  SessionSection,
  PcTaskModeSection,
];

// wrapUserMessage 追加的用户问题标题 (双语文案唯一事实源, rounds.ts 的包装判定也引用它)
export const QuestionTitle = { zh: '## 用户的问题', en: "## User's Question" } as const;

export function questionPattern(lang: 'zh' | 'en'): RegExp {
  return new RegExp(`^${escapeRegExp(QuestionTitle[lang])}$`, 'm');
}
