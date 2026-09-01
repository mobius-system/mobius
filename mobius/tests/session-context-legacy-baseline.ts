/**
 * tests/session-context-legacy-baseline.ts — 旧版 formatBody 的逐字节基线.
 *
 * 从 services/session-context.ts (重构前) 原样复制的常量 + zh_add_ / en_add_ + ADD_FNS + formatBody,
 * 仅外层包一层 makeLegacyFormatBody(deps) 把服务端依赖 (PORT/token 工厂/isGitRepoRoot/…) 参数化,
 * 函数体本身零改动, 作为新旧实现一致性对比的基准. 重构完成后本文件保留为回归基线.
 */
export interface LegacyDeps {
  PORT: number;
  HIDDEN_FOLDER_NAME: string;
  SKILLS_SUBDIR: string;
  createChiefTeamToken: (researchId: string, chiefSessionId: string) => string;
  createResearchSessionToken: (researchId: string, sessionId: string) => string;
  RESEARCH_SESSION_TOKEN_HEADER: string;
  TEAM_TOKEN_HEADER: string;
  isGitRepoRoot: (root: string) => boolean;
  isAssistantSession: (session: any, user?: any) => boolean;
  pcTaskModePrompt: (raw: unknown, language: 'zh' | 'en') => string;
  BUILTIN_MEMORIES: any[];
}

export function makeLegacyFormatBody(D: LegacyDeps) {
  const PORT = D.PORT;
  const HIDDEN_FOLDER_NAME = D.HIDDEN_FOLDER_NAME;
  const SKILLS_SUBDIR = D.SKILLS_SUBDIR;
  const createChiefTeamToken = D.createChiefTeamToken;
  const createResearchSessionToken = D.createResearchSessionToken;
  const RESEARCH_SESSION_TOKEN_HEADER = D.RESEARCH_SESSION_TOKEN_HEADER;
  const TEAM_TOKEN_HEADER = D.TEAM_TOKEN_HEADER;
  const isGitRepoRoot = D.isGitRepoRoot;
  const isAssistantSession = D.isAssistantSession;
  const pcTaskModePrompt = D.pcTaskModePrompt;
  const BUILTIN_MEMORIES = D.BUILTIN_MEMORIES;

const ISSUE_STATUS_LABELS: Record<string, string> = { active: '开放', in_progress: '进行中', completed: '已解决', open: '开放' };
const RESEARCH_STATUS_LABELS: Record<string, string> = { active: '开放', completed: '已完成' };
const SESSION_STATUS_LABELS: Record<string, string> = { active: '进行中', archived: '已归档', completed: '已完成' };
const ISSUE_STATUS_LABELS_EN: Record<string, string> = { active: 'Open', in_progress: 'In Progress', completed: 'Resolved', open: 'Open' };
const RESEARCH_STATUS_LABELS_EN: Record<string, string> = { active: 'Open', completed: 'Completed' };
const SESSION_STATUS_LABELS_EN: Record<string, string> = { active: 'In Progress', archived: 'Archived', completed: 'Completed' };

// 注入上下文语言归一: 仅 'zh' / 'en', 其余回退中文.
function normalizeLanguage(value: any): 'zh' | 'en' {
  return value === 'en' ? 'en' : 'zh';
}

function indent(text: any, prefix: string = '  '): string {
  return String(text || '').split('\n').map((l: string) => prefix + l).join('\n');
}

function shuffled<T>(items: T[]): T[] {
  const out = Array.isArray(items) ? [...items] : [];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// =====================================================================
// 上下文分段拼装函数. 每段都有中文 (zh_add_*) 与英文 (en_add_*) 两版,
// 由 formatBody 按 session 的 language 选用. 新增字段时务必同步两版.
// =====================================================================

function researchBlackboardUrl(researchId: string): string {
  return `http://localhost:${PORT}/api/research-blackboard/${researchId}`;
}

// ---------- 中文版 ----------

function zh_add_header(lines: string[]): void {
  lines.push('以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.');
  lines.push('');
}

function zh_add_user_level_info(lines: string[], user: any): void {
  if (!user) return;
  lines.push('## 用户');
  lines.push(`- 姓名: ${user.display_name || user.id}`);
  lines.push(`- 角色: ${user.role === 'admin' ? '管理员' : user.role === 'developer' ? '开发者' : '成员'}`);
  lines.push(`- 倾向语言: 中文`);
  lines.push('');
}

function zh_add_project_level_info(lines: string[], project: any): void {
  if (!project) return;
  lines.push('## 项目');
  lines.push(`- 名称: ${project.name}`);
  if (project.description) {
    lines.push('- 描述:');
    lines.push(indent(project.description));
  }
  lines.push('');
}

function zh_add_issue_level_info(lines: string[], issue: any): void {
  if (!issue) return;
  lines.push('## Issue');
  lines.push(`- 标题: ${issue.title}`);
  lines.push(`- 状态: ${ISSUE_STATUS_LABELS[issue.status] || issue.status || '未知'}`);
  if (issue.description) {
    lines.push('- 描述:');
    lines.push(indent(issue.description));
  }
  lines.push('');
}

function zh_add_research_level_info(lines: string[], research: any): void {
  if (!research) return;
  lines.push('## Research');
  lines.push(`- ID: ${research.id}`);
  lines.push(`- 标题: ${research.title}`);
  lines.push(`- 状态: ${RESEARCH_STATUS_LABELS[research.status] || research.status || '未知'}`);
  if (research.description) {
    lines.push('- 描述:');
    lines.push(indent(research.description));
  }
  lines.push('');
}

function zh_add_session_level_info(lines: string[], session: any): void {
  if (!session) return;
  lines.push('## Session');
  lines.push(`- 名称: ${session.name}`);
  lines.push(`- 状态: ${SESSION_STATUS_LABELS[session.status] || session.status || '未知'}`);
  if (session.research_role) {
    lines.push(`- 角色: ${session.research_role}`);
  }
  if (session.description) {
    lines.push('- 描述:');
    lines.push(indent(session.description));
  }
  lines.push('');
}

function zh_add_research_blackboard_info(lines: string[], research: any, session: any): void {
  if (!(research && research.id)) return;
  const url = researchBlackboardUrl(research.id);
  const author = session?.research_role || 'research_assistant';
  const sessionId = session?.session_id && session.session_id !== '(待创建)' ? session.session_id : '';
  const sessionToken = sessionId ? createResearchSessionToken(research.id, sessionId) : '';
  lines.push('## Research Blackboard');
  lines.push(`当前研究的 Blackboard 只能通过 Mobius HTTP API 读写。不要直接编辑 \`${HIDDEN_FOLDER_NAME}/blackboard/${research.id}/blackboard.jsonl\` 文件。`);
  lines.push('');
  lines.push('读取完整 Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl${sessionToken ? ` -H '${RESEARCH_SESSION_TOKEN_HEADER}: ${sessionToken}'` : ''} ${url}`);
  lines.push('```');
  lines.push('');
  lines.push('写入 Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl -X POST ${url} \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  if (sessionToken) lines.push(`  -H '${RESEARCH_SESSION_TOKEN_HEADER}: ${sessionToken}' \\`);
  lines.push(`  -d '{"author":"${author}${sessionId ? ` (${sessionId})` : ''}","session_id":"${sessionId}","content":"这里写入你的研究进展、发现或需要同步给团队的信息"}'`);
  lines.push('```');
  lines.push('');
  lines.push('Blackboard 内容只记录写入者和内容，不指定接收者。任意写入都会在后台投递给本 Research 中其他已创建 session。');
  lines.push('');
  if (session?.research_role === 'chief_researcher' && session?.session_id && research?.mode === 'chief_led') {
    const capability = createChiefTeamToken(research.id, session.session_id);
    const teamUrl = `http://localhost:${PORT}/api/researches/${research.id}/team`;
    lines.push('## Chief 团队管理能力');
    lines.push(`- 当前 Assistant limit: ${research.assistant_limit || 3}（Chief 不占名额，且你不能修改 limit）`);
    lines.push('- 只有在用户明确授权后才能招募 Assistant；能由现有成员完成时不要扩编。');
    lines.push('- 招募前必须说明现有团队为什么无法完成、缺少什么能力、预期产出是什么。');
    lines.push('- 删除 Agent 必须提供删除理由和未完成任务交接；你不能创建或删除 Chief。');
    lines.push(`- 查询团队: GET ${teamUrl}`);
    lines.push(`- 创建 Assistant: POST ${teamUrl}/agents`);
    lines.push(`- 移除 Assistant: DELETE ${teamUrl}/agents/<session_id>`);
    lines.push(`- 请求头: ${TEAM_TOKEN_HEADER}: ${capability}`);
    lines.push('- 创建请求必填: name, purpose, model, skill_ids, memory_ids, memory_selection_confirmed=true, initial_prompt, recruit_reason, expected_outcome, request_id，以及按钮 authorization_id 或自然语言 authorization_quote。');
    lines.push('');
  }
}

function zh_add_research_peer_info(lines: string[], peers: any[]): void {
  if (!Array.isArray(peers) || peers.length === 0) return;
  lines.push('## 已有 Research Sessions');
  for (const p of peers) {
    lines.push(`- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`);
  }
  lines.push('');
}

function zh_add_memory_info(lines: string[], memories: any[], project: any, issue: any): void {
  const all = [...BUILTIN_MEMORIES, ...(Array.isArray(memories) ? memories : [])];
  if (all.length === 0) return;
  lines.push('## 持久 Memory');
  lines.push('本用户与项目积累的长期事实 / 偏好如下. 视作已知信息.');
  lines.push('');
  all.forEach((m: any, idx: number) => {
    lines.push(`### ${m.name}`);
    if (m.description) lines.push(`> ${m.description}`);
    lines.push('');
    lines.push((m.body || '').replace(/\r\n/g, '\n').trimEnd());
    lines.push('');
    if (idx < all.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });
  if (project && project.bind_path) {
    const pkPath = `${project.bind_path}/${HIDDEN_FOLDER_NAME}/project_knowledge.md`;
    const ikPath = (issue && issue.id)
      ? `${project.bind_path}/${HIDDEN_FOLDER_NAME}/issue_knowledge/${issue.id}/issue_knowledge.md`
      : '';
    if (ikPath) {
      lines.push(`此外，如果需要记住一些信息供未来使用，请写入对应的知识文件（不要写入 ~/.codex 或 ~/.claude）：`);
      lines.push(`- 如果是项目通用知识（整体事实、通用做法、跨任务可复用的经验，写入 project_knowledge 的内容务必非常非常精简、克制）→ \`${pkPath}\`；`);
      lines.push(`- 如果是仅与当前任务相关、通用性有限的知识，写入 issue_knowledge（简洁、不要废话） → \`${ikPath}\`；`);
    } else {
      lines.push(`此外，如果需要记住一些信息供未来使用，请写入 ${project.bind_path}/${HIDDEN_FOLDER_NAME}/project_knowledge.md，不要写入 ~/.codex 或者 ~/.claude。`);
    }
    lines.push('');
  }
}

function zh_add_skill_info(lines: string[], skills: any[]): void {
  if (!skills || skills.length === 0) return;
  lines.push('## 必要 Skill');
  lines.push('以下Skill与当前问题可能有关，在解决问题之前，你必须根据实际需要，有选择性地理解并学习以下skill');
  lines.push('');
  for (const sk of skills) {
    const rel = sk.dirName ? `${SKILLS_SUBDIR}/${sk.dirName}/SKILL.md` : '(未知路径)';
    lines.push(`- **${sk.name}**`);
    lines.push(`  - 路径: \`${rel}\``);
    if (sk.description) lines.push(`  - 简介: ${sk.description}`);
  }
  lines.push('');
}

function zh_add_worktree_info(lines: string[], issue: any, project: any, session: any): void {
  const wt = (issue && issue.use_worktree && project && project.bind_path)
    ? { root: project.bind_path, branch: issue.worktree_branch }
    : null;
  if (!wt) return;
  if (!isGitRepoRoot(wt.root)) {
    lines.push('## Git Worktree 设置');
    lines.push(`本 Issue 勾选了 git worktree，但项目绑定路径 \`${wt.root}\` 当前不是 Git 仓库根。平台已忽略 git worktree 选项。`);
    lines.push(`请直接在普通工作目录 \`${wt.root}\` 内完成任务，不要创建或切换 git worktree。`);
    lines.push('');
    return;
  }
  const wtPath = `${wt.root}/${wt.branch}`;
  lines.push('## Git Worktree 工作区 (必读, 任务开始前优先执行)');
  lines.push(`本 Issue 启用 git worktree. 仓库根: \`${wt.root}\` ; 你的工作区: \`${wtPath}\` (分支 \`${wt.branch}\`).`);
  lines.push('平台只创建了该路径下的空占位目录, **真正的 git worktree 需要你来创建**.');
  lines.push('');
  lines.push('### 第一步 (任何任务动作之前)');
  lines.push('在仓库根把占位目录初始化为 git worktree, 创建并检出分支, 然后进入工作区:');
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wt.root}"`);
  lines.push(`rm -rf "${wtPath}"   # 平台占位空目录; git worktree add 不接受已存在目录`);
  lines.push(`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`);
  lines.push(`  || git worktree add "${wtPath}" "${wt.branch}"   # 分支已存在则复用`);
  lines.push(`cd "${wtPath}"`);
  lines.push('```');
  lines.push('');
  lines.push('此后所有代码改动都在该 worktree 内进行. (备注：可能存在不止一个git仓库，请随机应变）');
  lines.push('');
  lines.push(isAssistantSession(session)
    ? '### 任务完成时 (成功或失败)'
    : '### 任务完成时 (成功或失败, 在删除下方 running.flag 之前必须做)');
  lines.push(`把分支 \`${wt.branch}\` 合并到 \`agent_smart_dev\` 分支:`);
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wtPath}"`);
  lines.push(`git add -A && git commit -m "task: ${wt.branch}" || true`);
  lines.push(`cd "${wt.root}"`);
  lines.push('git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev');
  lines.push('git checkout agent_smart_dev');
  lines.push(`git merge "${wt.branch}"`);
  lines.push('```');
  lines.push('');
  lines.push('若合并有冲突, 必须解决全部冲突后再完成合并; 合并完成后重新运行测试验证需求是否满足. 若仍有冲突或测试不通过, 继续修复 → 重新合并 → 重新测试, **直到没有冲突且测试通过为止**.');
  lines.push('一切结束后，尝试git push，如果因为认证，失败了也没关系，跳过即可。');
  if (!isAssistantSession(session)) {
    lines.push(`提示: running.flag 位于仓库根 \`${wt.root}/${HIDDEN_FOLDER_NAME}/...\`, 不在 worktree 内 — 重建/删除 worktree 目录时不要误删它.`);
  }
  lines.push('');
}

function zh_add_completion_flag_info(lines: string[], session: any, project: any): void {
  if (!(session && session.session_id && session.session_id !== '(待创建)')) return;
  if (isAssistantSession(session)) return;
  const flagRoot = (project && project.bind_path) ? project.bind_path : '.';
  const flagPath = `${flagRoot}/${HIDDEN_FOLDER_NAME}/flags/${session.session_id}/running.flag`;
  lines.push('## 当任务完成时的最后一步');
  lines.push(`当任务最终成功或者最终失败时，你需要删除标记文件 ${flagPath}。但是，不要轻易放弃，尝试一切可能解决问题的方法，直到你确信无法继续为止。`);
  lines.push(`每当用户提出新问题新指令时，都会创建新的running.flag。`);
}

function zh_add_pc_task_mode_info(lines: string[], session: any): void {
  if (!session) return;
  const prompt = pcTaskModePrompt(session.pc_client_metadata, 'zh');
  if (!prompt) return;
  lines.push('\n## PC/Terminal 任务模式\n');
  lines.push(prompt + '\n');
}

// ---------- 英文版 ----------

function en_add_header(lines: string[]): void {
  lines.push('The following describes the user you are assisting, and the Project, Issue/Research, and Session this work belongs to.');
  lines.push('Use it to calibrate how you address the user and the scope of your work; do not ask for fields already listed here.');
  lines.push('');
}

function en_add_user_level_info(lines: string[], user: any): void {
  if (!user) return;
  lines.push('## User');
  lines.push(`- Name: ${user.display_name || user.id}`);
  lines.push(`- Role: ${user.role === 'admin' ? 'Admin' : user.role === 'developer' ? 'Developer' : 'Member'}`);
  lines.push(`- Language Preference: English`);
  lines.push('');
}

function en_add_project_level_info(lines: string[], project: any): void {
  if (!project) return;
  lines.push('## Project');
  lines.push(`- Name: ${project.name}`);
  if (project.description) {
    lines.push('- Description:');
    lines.push(indent(project.description));
  }
  lines.push('');
}

function en_add_issue_level_info(lines: string[], issue: any): void {
  if (!issue) return;
  lines.push('## Issue');
  lines.push(`- Title: ${issue.title}`);
  lines.push(`- Status: ${ISSUE_STATUS_LABELS_EN[issue.status] || issue.status || 'Unknown'}`);
  if (issue.description) {
    lines.push('- Description:');
    lines.push(indent(issue.description));
  }
  lines.push('');
}

function en_add_research_level_info(lines: string[], research: any): void {
  if (!research) return;
  lines.push('## Research');
  lines.push(`- ID: ${research.id}`);
  lines.push(`- Title: ${research.title}`);
  lines.push(`- Status: ${RESEARCH_STATUS_LABELS_EN[research.status] || research.status || 'Unknown'}`);
  if (research.description) {
    lines.push('- Description:');
    lines.push(indent(research.description));
  }
  lines.push('');
}

function en_add_session_level_info(lines: string[], session: any): void {
  if (!session) return;
  lines.push('## Session');
  lines.push(`- Name: ${session.name}`);
  lines.push(`- Status: ${SESSION_STATUS_LABELS_EN[session.status] || session.status || 'Unknown'}`);
  if (session.research_role) {
    lines.push(`- Research Role: ${session.research_role}`);
  }
  if (session.description) {
    lines.push('- Description:');
    lines.push(indent(session.description));
  }
  lines.push('');
}

function en_add_research_blackboard_info(lines: string[], research: any, session: any): void {
  if (!(research && research.id)) return;
  const url = researchBlackboardUrl(research.id);
  const author = session?.research_role || 'research_assistant';
  const sessionId = session?.session_id && session.session_id !== '(待创建)' ? session.session_id : '';
  const sessionToken = sessionId ? createResearchSessionToken(research.id, sessionId) : '';
  lines.push('## Research Blackboard');
  lines.push(`This research's Blackboard can only be read and written through the Mobius HTTP API. Do not directly edit the \`${HIDDEN_FOLDER_NAME}/blackboard/${research.id}/blackboard.jsonl\` file.`);
  lines.push('');
  lines.push('Read the full Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl${sessionToken ? ` -H '${RESEARCH_SESSION_TOKEN_HEADER}: ${sessionToken}'` : ''} ${url}`);
  lines.push('```');
  lines.push('');
  lines.push('Write to the Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl -X POST ${url} \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  if (sessionToken) lines.push(`  -H '${RESEARCH_SESSION_TOKEN_HEADER}: ${sessionToken}' \\`);
  lines.push(`  -d '{"author":"${author}${sessionId ? ` (${sessionId})` : ''}","session_id":"${sessionId}","content":"Write your research progress, findings, or anything to sync with the team here"}'`);
  lines.push('```');
  lines.push('');
  lines.push('A Blackboard entry records only its author and content, with no designated recipient. Any write is delivered in the background to the other sessions already created in this Research.');
  lines.push('');
  if (session?.research_role === 'chief_researcher' && session?.session_id && research?.mode === 'chief_led') {
    const capability = createChiefTeamToken(research.id, session.session_id);
    const teamUrl = `http://localhost:${PORT}/api/researches/${research.id}/team`;
    lines.push('## Chief team-management capability');
    lines.push(`- Current Assistant limit: ${research.assistant_limit || 3}; the Chief does not count and cannot change it.`);
    lines.push('- Recruit only after explicit user authorization and record why the current team cannot do the work.');
    lines.push('- Removing an Agent requires a reason and unfinished-work handoff. You cannot create or remove a Chief.');
    lines.push(`- Team state: GET ${teamUrl}`);
    lines.push(`- Recruit Assistant: POST ${teamUrl}/agents`);
    lines.push(`- Remove Assistant: DELETE ${teamUrl}/agents/<session_id>`);
    lines.push(`- Header: ${TEAM_TOKEN_HEADER}: ${capability}`);
    lines.push('');
  }
}

function en_add_research_peer_info(lines: string[], peers: any[]): void {
  if (!Array.isArray(peers) || peers.length === 0) return;
  lines.push('## Existing Research Sessions');
  for (const p of peers) {
    lines.push(`- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`);
  }
  lines.push('');
}

function en_add_memory_info(lines: string[], memories: any[], project: any, issue: any): void {
  const all = [...BUILTIN_MEMORIES, ...(Array.isArray(memories) ? memories : [])];
  if (all.length === 0) return;
  lines.push('## Persistent Memory');
  lines.push('Long-term facts / preferences accumulated for this user and project are listed below. Treat them as known information.');
  lines.push('');
  all.forEach((m: any, idx: number) => {
    lines.push(`### ${m.name}`);
    if (m.description) lines.push(`> ${m.description}`);
    lines.push('');
    lines.push((m.body || '').replace(/\r\n/g, '\n').trimEnd());
    lines.push('');
    if (idx < all.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });
  if (project && project.bind_path) {
    const pkPath = `${project.bind_path}/${HIDDEN_FOLDER_NAME}/project_knowledge.md`;
    const ikPath = (issue && issue.id)
      ? `${project.bind_path}/${HIDDEN_FOLDER_NAME}/issue_knowledge/${issue.id}/issue_knowledge.md`
      : '';
    if (ikPath) {
      lines.push(`Additionally, if you need to remember information for future sessions, write it to the appropriate knowledge file (do not write to ~/.codex or ~/.claude):`);
      lines.push(`- For project-wide general knowledge (overall facts, common practices, cross-task reusable experience; keep what you write into project_knowledge concise and restrained) → \`${pkPath}\`;`);
      lines.push(`- For knowledge relevant only to the current task with limited generality, write to issue_knowledge → \`${ikPath}\`;`);
    } else {
      lines.push(`Additionally, if you need to remember information for future sessions, please write to ${project.bind_path}/${HIDDEN_FOLDER_NAME}/project_knowledge.md, do not write to ~/.codex or ~/.claude.`);
    }
    lines.push('');
  }
}

function en_add_skill_info(lines: string[], skills: any[]): void {
  if (!skills || skills.length === 0) return;
  lines.push('## Required Skills');
  lines.push('Before solving the problem, you can read and learn the following skills according to your need.');
  lines.push('');
  for (const sk of skills) {
    const rel = sk.dirName ? `${SKILLS_SUBDIR}/${sk.dirName}/SKILL.md` : '(unknown path)';
    lines.push(`- **${sk.name}**`);
    lines.push(`  - Path: \`${rel}\``);
    if (sk.description) lines.push(`  - Summary: ${sk.description}`);
  }
  lines.push('');
}

function en_add_worktree_info(lines: string[], issue: any, project: any, session: any): void {
  const wt = (issue && issue.use_worktree && project && project.bind_path)
    ? { root: project.bind_path, branch: issue.worktree_branch }
    : null;
  if (!wt) return;
  if (!isGitRepoRoot(wt.root)) {
    lines.push('## Git Worktree Setup');
    lines.push(`This Issue enabled git worktree, but the project bind path \`${wt.root}\` is currently not a Git repository root. The platform has ignored the git worktree option.`);
    lines.push(`Please complete the task directly in the normal working directory \`${wt.root}\`; do not create or switch git worktrees.`);
    lines.push('');
    return;
  }
  const wtPath = `${wt.root}/${wt.branch}`;
  lines.push('## Git Worktree Workspace (must read, do this first before starting the task)');
  lines.push(`This Issue enables git worktree. Repo root: \`${wt.root}\` ; your workspace: \`${wtPath}\` (branch \`${wt.branch}\`).`);
  lines.push('The platform only created an empty placeholder directory at that path; **you must create the actual git worktree yourself**.');
  lines.push('');
  lines.push('### Step 1 (before any task action)');
  lines.push('In the repo root, initialize the placeholder directory as a git worktree, create and check out the branch, then enter the workspace:');
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wt.root}"`);
  lines.push(`rm -rf "${wtPath}"   # platform placeholder empty dir; git worktree add does not accept an existing directory`);
  lines.push(`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`);
  lines.push(`  || git worktree add "${wtPath}" "${wt.branch}"   # reuse the branch if it already exists`);
  lines.push(`cd "${wtPath}"`);
  lines.push('```');
  lines.push('');
  lines.push('From now on, make all code changes inside this worktree. (Note: there may be more than one git repo, so adapt as needed.)');
  lines.push('');
  lines.push(isAssistantSession(session)
    ? '### When the task is done (success or failure)'
    : '### When the task is done (success or failure, must do this before deleting the running.flag below)');
  lines.push(`Merge branch \`${wt.branch}\` into the \`agent_smart_dev\` branch:`);
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wtPath}"`);
  lines.push(`git add -A && git commit -m "task: ${wt.branch}" || true`);
  lines.push(`cd "${wt.root}"`);
  lines.push('git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev');
  lines.push('git checkout agent_smart_dev');
  lines.push(`git merge "${wt.branch}"`);
  lines.push('```');
  lines.push('');
  lines.push('If the merge has conflicts, you must resolve all of them before completing the merge; after merging, re-run the tests to verify the requirements are met. If conflicts remain or tests fail, keep fixing → re-merging → re-testing, **until there are no conflicts and the tests pass**.');
  lines.push('When everything is done, try git push; if it fails due to authentication, that is fine, just skip it.');
  if (!isAssistantSession(session)) {
    lines.push(`Note: running.flag lives at the repo root \`${wt.root}/${HIDDEN_FOLDER_NAME}/...\`, not inside the worktree — do not accidentally delete it when rebuilding/removing the worktree directory.`);
  }
  lines.push('');
}

function en_add_completion_flag_info(lines: string[], session: any, project: any): void {
  if (!(session && session.session_id && session.session_id !== '(待创建)')) return;
  if (isAssistantSession(session)) return;
  const flagRoot = (project && project.bind_path) ? project.bind_path : '.';
  const flagPath = `${flagRoot}/${HIDDEN_FOLDER_NAME}/flags/${session.session_id}/running.flag`;
  lines.push('## Final step when the task is complete');
  lines.push(`When the task ultimately succeeds or ultimately fails, you must delete the marker file ${flagPath}. But do not give up easily — try every possible way to solve the problem until you are convinced you cannot continue.`);
  lines.push('When user gives new instruction again, running.flag will be recreated.');
}

// PC task mode prompt injection (Electron/TUI sessions only, when
// session.pc_client_metadata is non-null; web sessions return early).
function en_add_pc_task_mode_info(lines: string[], session: any): void {
  if (!session) return;
  const prompt = pcTaskModePrompt(session.pc_client_metadata, 'en');
  if (!prompt) return;
  lines.push('\n## PC/Terminal Task Mode\n');
  lines.push(prompt + '\n');
}

const ADD_FNS: Record<string, any> = {
  zh: {
    header: zh_add_header,
    user: zh_add_user_level_info,
    project: zh_add_project_level_info,
    research: zh_add_research_level_info,
    researchBlackboard: zh_add_research_blackboard_info,
    researchPeer: zh_add_research_peer_info,
    memory: zh_add_memory_info,
    skill: zh_add_skill_info,
    worktree: zh_add_worktree_info,
    completionFlag: zh_add_completion_flag_info,
    issue: zh_add_issue_level_info,
    session: zh_add_session_level_info,
    pcTaskMode: zh_add_pc_task_mode_info,
  },
  en: {
    header: en_add_header,
    user: en_add_user_level_info,
    project: en_add_project_level_info,
    research: en_add_research_level_info,
    researchBlackboard: en_add_research_blackboard_info,
    researchPeer: en_add_research_peer_info,
    memory: en_add_memory_info,
    skill: en_add_skill_info,
    worktree: en_add_worktree_info,
    completionFlag: en_add_completion_flag_info,
    issue: en_add_issue_level_info,
    session: en_add_session_level_info,
    pcTaskMode: en_add_pc_task_mode_info,
  },
};

function formatBody({ user, project, issue, research, session, skills, memories, research_peers, language }: any): string {
  const fns = ADD_FNS[normalizeLanguage(language)];
  const lines: string[] = [];
  fns.header(lines);
  fns.user(lines, user);
  fns.project(lines, project);
  fns.research(lines, research);
  fns.researchBlackboard(lines, research, session);
  fns.researchPeer(lines, research_peers);
  fns.memory(lines, memories, project, issue);
  fns.skill(lines, skills);
  fns.worktree(lines, issue, project, session);
  fns.completionFlag(lines, session, project);
  fns.issue(lines, issue);
  fns.session(lines, session);
  fns.pcTaskMode(lines, session);
  return lines.join('\n').trimEnd();
}

  return formatBody;
}
