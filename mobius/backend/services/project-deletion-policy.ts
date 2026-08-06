import path from 'path';
import { APP_DIR } from '../config';

export const FIXED_LOGO_REVIEW_PROJECT_ID = '9986bdc3';

export type ProjectDeleteMode = 'creator' | 'system_admin_override';

export interface ProjectDeletePolicy {
  allowed: boolean;
  mode: ProjectDeleteMode | null;
  requires_password: boolean;
  requires_reason: boolean;
  protected: boolean;
  denial_reason: string | null;
}

function protectedPolicy(reason: string): ProjectDeletePolicy {
  return {
    allowed: false,
    mode: null,
    requires_password: true,
    requires_reason: false,
    protected: true,
    denial_reason: reason,
  };
}

function isSelfDevelopProject(project: any): boolean {
  if (project?.is_self_develop === true) return true;
  const bindPath = typeof project?.bind_path === 'string' ? project.bind_path.trim() : '';
  if (!bindPath || !APP_DIR) return false;
  return path.resolve(bindPath) === path.resolve(APP_DIR);
}

export function projectDeletePolicy(project: any, actor: any): ProjectDeletePolicy {
  if (!project || !actor?.id) {
    return {
      allowed: false,
      mode: null,
      requires_password: true,
      requires_reason: false,
      protected: false,
      denial_reason: '当前账号没有删除此项目的权限。',
    };
  }
  if (project.id === FIXED_LOGO_REVIEW_PROJECT_ID) {
    return protectedPolicy('该项目是引导系统的固定验收案例，不能删除。');
  }
  if (project.kind === 'extension') {
    return protectedPolicy('拓展项目由拓展目录统一管理，不能在项目设置中删除。');
  }
  if (isSelfDevelopProject(project)) {
    return protectedPolicy('Mobius 自迭代项目不能通过网页删除，请使用受控运维流程处理。');
  }
  if (project.created_by === actor.id) {
    return {
      allowed: true,
      mode: 'creator',
      requires_password: true,
      requires_reason: false,
      protected: false,
      denial_reason: null,
    };
  }
  if (actor.role === 'admin') {
    return {
      allowed: true,
      mode: 'system_admin_override',
      requires_password: true,
      requires_reason: true,
      protected: false,
      denial_reason: null,
    };
  }
  return {
    allowed: false,
    mode: null,
    requires_password: true,
    requires_reason: false,
    protected: false,
    denial_reason: '当前账号不能直接删除此项目。请联系项目创建者处理；如无法确认创建者，请联系系统管理员协助。',
  };
}
