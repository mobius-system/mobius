import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { db } from '../../db';

interface SessionWorkspaceRow {
  project_id: string | null;
  issue_id: string | null;
  scope_type: string | null;
  research_id: string | null;
  project_name: string | null;
  bind_path: string | null;
  use_worktree: number | null;
  worktree_branch: string | null;
  research_title: string | null;
}

function gitTopLevel(abs: string): string | null {
  const r = spawnSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const top = (r.stdout || '').trim();
  return top ? path.resolve(top) : null;
}

function isGitRepoRoot(abs: string): boolean {
  return gitTopLevel(abs) === path.resolve(abs);
}

// 解析某 session 下的 CC_WORK_DIR. 调用方必须先完成 Session 权限判断。
//   规则: 基于 session 所属 project 的 bind_path.
//   - session 必须绑定 project
//   - project 必须有 bind_path, 且真实存在且为目录
//   - 若所属 Issue 启用 git worktree 且 bind_path 是 Git 仓库根:
//     workDir = bind_path/<分支>, 平台只创建该空目录占位 (mkdir -p);
//     真正的 `git worktree add` 由 agent 执行 (见 session-context.js 注入的提示).
//   - 若 Issue 勾了 git worktree 但 bind_path 不是 Git 仓库根: 忽略该选项,
//     降级为普通工作目录 bind_path.
//   任一前置条件不满足 → 返回 { error }, 由调用方拒绝执行并提示用户去补齐.
// 返回 { workDir, projectRoot, worktree, branch, projectName } 或 { error }.
//   projectRoot — bind_path 仓库根 (running.flag 锚定在此, 不随 worktree 漂移)
function resolveSessionWorkspace(user: any, sessionId: string): any {
  const session = db.prepare(`
    SELECT s.project_id, s.issue_id, s.scope_type, s.research_id,
           p.name as project_name, p.bind_path as bind_path,
           i.use_worktree as use_worktree, i.worktree_branch as worktree_branch,
           r.title as research_title
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
    WHERE s.session_id = ?
  `).get(sessionId) as SessionWorkspaceRow | undefined;

  if (!session || !session.project_id) {
    return { error: 'Session 未关联到项目, 无法确定工作目录' };
  }
  const bindPath = (session.bind_path || '').trim();
  if (!bindPath) {
    return { error: `项目「${session.project_name || session.project_id}」尚未配置绑定路径, 请到项目设置补全 bind_path 后再发起对话` };
  }
  const abs = path.resolve(bindPath);
  if (!fs.existsSync(abs)) {
    return { error: `项目绑定路径不存在: ${abs}`, projectRoot: abs };
  }
  try {
    if (!fs.statSync(abs).isDirectory()) {
      return { error: `项目绑定路径不是目录: ${abs}` };
    }
  } catch (e) {
    return { error: `项目绑定路径不可访问: ${abs}` };
  }

  if (session.scope_type === 'research') {
    return {
      workDir: abs,
      projectRoot: abs,
      worktree: false,
      branch: null,
      projectName: session.project_name || '',
      researchId: session.research_id || null,
      researchTitle: session.research_title || '',
    };
  }

  const useWorktree = !!session.use_worktree;
  if (useWorktree) {
    const resolvedGitRoot = gitTopLevel(abs);
    if (resolvedGitRoot !== abs) {
      const branch = ((session.worktree_branch || '').trim() || session.issue_id) as string;
      return {
        workDir: abs,
        projectRoot: abs,
        worktree: false,
        branch: null,
        projectName: session.project_name || '',
        worktreeIgnored: true,
        requestedBranch: branch,
        worktreeIgnoreReason: `Issue 启用了 git worktree，但项目绑定路径不是 Git 仓库根，已忽略 git worktree 选项并改用普通工作目录: ${abs}`,
      };
    }

    const branch = ((session.worktree_branch || '').trim() || session.issue_id) as string;
    const wtPath = path.join(abs, branch);
    if (wtPath !== abs && !wtPath.startsWith(abs + path.sep)) {
      return { error: `worktree 分支名非法 (路径越界): ${branch}` };
    }
    // 平台只创建空占位目录; agent 第一步会清理并 git worktree add.
    try {
      fs.mkdirSync(wtPath, { recursive: true });
    } catch (e) {
      return { error: `创建 worktree 占位目录失败: ${wtPath} (${e.message})` };
    }
    return {
      workDir: wtPath,
      projectRoot: abs,
      worktree: true,
      branch,
      projectName: session.project_name || '',
    };
  }

  return {
    workDir: abs,
    projectRoot: abs,
    worktree: false,
    branch: null,
    projectName: session.project_name || '',
  };
}

export { resolveSessionWorkspace, gitTopLevel, isGitRepoRoot };
