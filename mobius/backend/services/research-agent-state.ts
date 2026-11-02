import { Sessions } from '../repositories/sessions';

export function assertResearchAgentEnabled(sessionId: string): void {
  const session = Sessions.findById(sessionId);
  if (session?.scope_type === 'research' && session.research_agent_disabled) {
    throw Object.assign(new Error('当前研究智能体处于禁用状态，请先通过专用解禁 API 解禁'), {
      status: 409, category: 'research_agent_disabled', code: 'research_agent_disabled',
    });
  }
}
