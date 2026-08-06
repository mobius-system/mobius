import { Issues } from '../repositories/issues';
import { Researches } from '../repositories/researches';
import { Sessions } from '../repositories/sessions';
// @ts-ignore - access-control is still a CommonJS-compatible JS service.
import { canReadIssue, canReadResearch, canReadSession } from './access-control';

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 500;

type SessionMatchMap = Record<string, any[]>;

function shapeSessionMatch(session: any): any {
  return {
    session_id: session.session_id,
    issue_id: session.issue_id || null,
    research_id: session.research_id || null,
    scope_type: session.scope_type,
    research_role: session.research_role || null,
    name: session.name || '',
    description: session.description || '',
    status: session.status,
    agent_status: session.agent_status,
    created_at: session.created_at,
    completed_at: session.completed_at,
    last_active: session.last_active,
    message_count: Number(session.message_count || 0),
  };
}

export type ProjectSessionSearchResult = {
  query: string;
  issues: SessionMatchMap;
  researches: SessionMatchMap;
  total: number;
  truncated: boolean;
};

export function normalizeProjectSessionQuery(value: unknown): string {
  return String(value || '').trim().slice(0, MAX_QUERY_LENGTH);
}

export function searchProjectSessionMetadata(projectId: string, value: unknown, user: any): ProjectSessionSearchResult {
  const query = normalizeProjectSessionQuery(value);
  const empty: ProjectSessionSearchResult = { query, issues: {}, researches: {}, total: 0, truncated: false };
  if (!projectId || !query || !user?.id) return empty;

  const readable = Sessions.searchActiveByProjectMetadata(projectId, query).filter((session: any) => {
    if (!canReadSession(user, session)) return false;
    if (session.scope_type === 'issue' && session.issue_id) {
      const issue = Issues.findById(String(session.issue_id), user.id);
      return !!issue && String(issue.project_id) === projectId && canReadIssue(user, issue);
    }
    if (session.scope_type === 'research' && session.research_id) {
      const research = Researches.findById(String(session.research_id));
      return !!research && String(research.project_id) === projectId && canReadResearch(user, research);
    }
    return false;
  });

  const truncated = readable.length > MAX_RESULTS;
  const matches = readable.slice(0, MAX_RESULTS);
  const issues: SessionMatchMap = {};
  const researches: SessionMatchMap = {};
  for (const session of matches) {
    const parentId = String(session.scope_type === 'research' ? session.research_id : session.issue_id);
    const target = session.scope_type === 'research' ? researches : issues;
    if (!target[parentId]) target[parentId] = [];
    target[parentId].push(shapeSessionMatch(session));
  }

  return { query, issues, researches, total: matches.length, truncated };
}
