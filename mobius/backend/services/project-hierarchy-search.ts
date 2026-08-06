import path from 'path';
import { Issues } from '../repositories/issues';
import { Projects } from '../repositories/projects';
import { Researches } from '../repositories/researches';
import { Sessions } from '../repositories/sessions';
import {
  canReadIssue,
  canReadProject,
  canReadResearch,
  canReadSession,
} from './access-control';

const MAX_QUERY_LENGTH = 200;
const MAX_PROJECT_RESULTS = 200;
const MAX_MATCHES_PER_PROJECT = 20;
const ISSUE_CANDIDATE_LIMIT = 1000;
const RESEARCH_CANDIDATE_LIMIT = 1000;
const SESSION_CANDIDATE_LIMIT = 2000;

export type ProjectHierarchyHitKind = 'issue' | 'research' | 'session' | 'research_agent';

export type ProjectHierarchyHit = {
  kind: ProjectHierarchyHitKind;
  id: string;
  title: string;
  description: string;
  status: string;
  last_active: string | null;
  parent_kind: 'issue' | 'research' | null;
  parent_id: string | null;
  parent_title: string | null;
  matched_fields: string[];
  score: number;
};

export type ProjectHierarchyGroup = {
  project: any;
  project_match: boolean;
  project_matched_fields: string[];
  matches: ProjectHierarchyHit[];
  total_matches: number;
  score: number;
};

export type ProjectHierarchySearchResult = {
  query: string;
  project_count: number;
  match_count: number;
  projects: ProjectHierarchyGroup[];
  truncated: boolean;
};

export function normalizeProjectHierarchyQuery(value: unknown): string {
  return String(value || '').trim().slice(0, MAX_QUERY_LENGTH);
}

function normalized(value: unknown): string {
  return String(value || '').toLocaleLowerCase();
}

function includesQuery(value: unknown, query: string): boolean {
  return normalized(value).includes(normalized(query));
}

function matchedFields(query: string, fields: Array<[string, unknown]>): string[] {
  return fields.filter(([, value]) => includesQuery(value, query)).map(([key]) => key);
}

function textScore(title: unknown, description: unknown, query: string, titleScore: number): number {
  const titleText = normalized(title);
  const q = normalized(query);
  if (titleText === q) return titleScore;
  if (titleText.startsWith(q)) return titleScore + 0.25;
  if (titleText.includes(q)) return titleScore + 0.5;
  return includesQuery(description, query) ? 5 : 9;
}

function projectMatchInfo(project: any, query: string): { fields: string[]; score: number } {
  const fields = matchedFields(query, [
    ['name', project.name],
    ['description', project.description],
    ['id', project.id],
    ['extension_name', project.extension_name],
    ['created_by_name', project.created_by_name],
    ['bind_path', project.bind_path ? path.basename(String(project.bind_path)) : ''],
  ]);
  if (!fields.length) return { fields, score: 9 };
  const name = normalized(project.name);
  const q = normalized(query);
  if (name === q) return { fields, score: 0 };
  if (name.startsWith(q)) return { fields, score: 1 };
  if (fields.includes('name')) return { fields, score: 1.5 };
  return { fields, score: 2 };
}

function emptyResult(query: string): ProjectHierarchySearchResult {
  return { query, project_count: 0, match_count: 0, projects: [], truncated: false };
}

export function searchProjectHierarchy(value: unknown, user: any): ProjectHierarchySearchResult {
  const query = normalizeProjectHierarchyQuery(value);
  if (!query || !user?.id) return emptyResult(query);

  const readableProjects = Projects.listAll(user.id)
    .filter((project: any) => project && canReadProject(user, project)) as any[];
  const projectById = new Map(readableProjects.map((project: any) => [String(project.id), project]));
  const groups = new Map<string, ProjectHierarchyGroup>();
  let truncated = false;

  function groupFor(projectId: unknown): ProjectHierarchyGroup | null {
    const id = String(projectId || '');
    const project = projectById.get(id);
    if (!project) return null;
    let group = groups.get(id);
    if (!group) {
      const ownMatch = projectMatchInfo(project, query);
      group = {
        project,
        project_match: ownMatch.fields.length > 0,
        project_matched_fields: ownMatch.fields,
        matches: [],
        total_matches: 0,
        score: ownMatch.score,
      };
      groups.set(id, group);
    }
    return group;
  }

  for (const project of readableProjects) {
    const info = projectMatchInfo(project, query);
    if (info.fields.length) groupFor(project.id);
  }

  const issueRows = Issues.searchMetadata(query, ISSUE_CANDIDATE_LIMIT + 1);
  if (issueRows.length > ISSUE_CANDIDATE_LIMIT) truncated = true;
  for (const issue of issueRows.slice(0, ISSUE_CANDIDATE_LIMIT)) {
    if (!projectById.has(String(issue.project_id)) || !canReadIssue(user, issue)) continue;
    const group = groupFor(issue.project_id);
    if (!group) continue;
    const fields = matchedFields(query, [['title', issue.title], ['description', issue.description]]);
    const score = textScore(issue.title, issue.description, query, 3);
    group.matches.push({
      kind: 'issue', id: String(issue.id), title: String(issue.title || ''), description: String(issue.description || ''),
      status: String(issue.status || ''), last_active: issue.last_active || null,
      parent_kind: null, parent_id: null, parent_title: null, matched_fields: fields, score,
    });
    group.total_matches += 1;
    group.score = Math.min(group.score, score);
  }

  const researchRows = Researches.searchMetadata(query, RESEARCH_CANDIDATE_LIMIT + 1);
  if (researchRows.length > RESEARCH_CANDIDATE_LIMIT) truncated = true;
  for (const research of researchRows.slice(0, RESEARCH_CANDIDATE_LIMIT)) {
    if (!projectById.has(String(research.project_id)) || !canReadResearch(user, research)) continue;
    const group = groupFor(research.project_id);
    if (!group) continue;
    const fields = matchedFields(query, [['title', research.title], ['description', research.description]]);
    const score = textScore(research.title, research.description, query, 3);
    group.matches.push({
      kind: 'research', id: String(research.id), title: String(research.title || ''), description: String(research.description || ''),
      status: String(research.status || ''), last_active: research.last_active || null,
      parent_kind: null, parent_id: null, parent_title: null, matched_fields: fields, score,
    });
    group.total_matches += 1;
    group.score = Math.min(group.score, score);
  }

  const issueCache = new Map<string, any>();
  const researchCache = new Map<string, any>();
  const sessionRows = Sessions.searchActiveMetadata(query, SESSION_CANDIDATE_LIMIT + 1);
  if (sessionRows.length > SESSION_CANDIDATE_LIMIT) truncated = true;
  for (const session of sessionRows.slice(0, SESSION_CANDIDATE_LIMIT)) {
    const projectId = String(session.project_id || '');
    if (!projectById.has(projectId) || !canReadSession(user, session)) continue;
    let parent: any = null;
    if (session.scope_type === 'research' && session.research_id) {
      const id = String(session.research_id);
      if (!researchCache.has(id)) researchCache.set(id, Researches.findById(id));
      parent = researchCache.get(id);
      if (!parent || !canReadResearch(user, parent)) continue;
    } else if (session.issue_id) {
      const id = String(session.issue_id);
      if (!issueCache.has(id)) issueCache.set(id, Issues.findById(id, user.id));
      parent = issueCache.get(id);
      if (!parent || !canReadIssue(user, parent)) continue;
    }
    if (!parent || String(parent.project_id) !== projectId) continue;
    const group = groupFor(projectId);
    if (!group) continue;
    const fields = matchedFields(query, [['title', session.name], ['description', session.description]]);
    const score = textScore(session.name, session.description, query, 4);
    const isResearch = session.scope_type === 'research';
    group.matches.push({
      kind: isResearch ? 'research_agent' : 'session',
      id: String(session.session_id), title: String(session.name || ''), description: String(session.description || ''),
      status: String(session.status || ''), last_active: session.last_active || null,
      parent_kind: isResearch ? 'research' : 'issue', parent_id: String(parent.id),
      parent_title: String(parent.title || ''), matched_fields: fields, score,
    });
    group.total_matches += 1;
    group.score = Math.min(group.score, score);
  }

  const allGroups = Array.from(groups.values());
  for (const group of allGroups) {
    group.matches.sort((a, b) => a.score - b.score || Date.parse(b.last_active || '') - Date.parse(a.last_active || ''));
    if (group.matches.length > MAX_MATCHES_PER_PROJECT) {
      group.matches = group.matches.slice(0, MAX_MATCHES_PER_PROJECT);
      truncated = true;
    }
  }
  allGroups.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const starDiff = Number(!!b.project.starred) - Number(!!a.project.starred);
    if (starDiff) return starDiff;
    return Date.parse(b.project.last_session_activity_at || b.project.last_active || '')
      - Date.parse(a.project.last_session_activity_at || a.project.last_active || '');
  });
  if (allGroups.length > MAX_PROJECT_RESULTS) truncated = true;
  const projects = allGroups.slice(0, MAX_PROJECT_RESULTS);
  const matchCount = projects.reduce((sum, group) => sum + group.total_matches + Number(group.project_match), 0);
  return { query, project_count: projects.length, match_count: matchCount, projects, truncated };
}
