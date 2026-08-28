import {
  completeBirthdayDemoState,
  isBirthdayDemoIssue,
  isBirthdayDemoProject,
  isBirthdayDemoSession,
  patchBirthdayDemoState,
  readBirthdayDemoState,
  type BirthdayDemoState,
} from './birthday-demo'
import {
  completeProjectImportDemoState,
  isProjectImportDemoIssue,
  isProjectImportDemoProject,
  isProjectImportDemoSession,
  patchProjectImportDemoState,
  readProjectImportDemoState,
  type ProjectImportDemoState,
} from './project-import-demo'
import {
  completeContextSetupDemoState,
  isContextSetupDemoIssue,
  isContextSetupDemoProject,
  isContextSetupDemoSession,
  patchContextSetupDemoState,
  readContextSetupDemoState,
  type ContextSetupDemoState,
} from './context-setup-demo'
import {
  completeExtensionDemoState,
  isExtensionDemoIssue,
  isExtensionDemoProject,
  isExtensionDemoSession,
  patchExtensionDemoState,
  readExtensionDemoState,
  type ExtensionDemoState,
} from './extension-demo'
import {
  completeSelfEvolveDemoState,
  isSelfEvolveDemoIssue,
  isSelfEvolveDemoProject,
  isSelfEvolveDemoSession,
  patchSelfEvolveDemoState,
  readSelfEvolveDemoState,
  type SelfEvolveDemoState,
} from './self-evolve-demo'
import {
  completeLogoReviewDemoState,
  isLogoReviewDemoCleanupProject,
  patchLogoReviewDemoState,
  readLogoReviewDemoState,
  type LogoReviewDemoState,
} from './logo-review-demo'

export type GuidedDemoKind = 'birthday' | 'project-import' | 'context-setup' | 'self-evolve' | 'extension' | 'logo-review'
export type GuidedDemoState = BirthdayDemoState | ProjectImportDemoState | ContextSetupDemoState | SelfEvolveDemoState | ExtensionDemoState | LogoReviewDemoState

export type ActiveGuidedDemo = {
  kind: GuidedDemoKind
  state: GuidedDemoState
}

export function readActiveGuidedDemo(preferred?: GuidedDemoKind): ActiveGuidedDemo | null {
  const birthday = readBirthdayDemoState()
  const projectImport = readProjectImportDemoState()
  const contextSetup = readContextSetupDemoState()
  const selfEvolve = readSelfEvolveDemoState()
  const extension = readExtensionDemoState()
  const logoReview = readLogoReviewDemoState()

  if (preferred === 'birthday' && birthday?.active) return { kind: 'birthday', state: birthday }
  if (preferred === 'project-import' && projectImport?.active) return { kind: 'project-import', state: projectImport }
  if (preferred === 'context-setup' && contextSetup?.active) return { kind: 'context-setup', state: contextSetup }
  if (preferred === 'self-evolve' && selfEvolve?.active) return { kind: 'self-evolve', state: selfEvolve }
  if (preferred === 'extension' && extension?.active) return { kind: 'extension', state: extension }
  if (preferred === 'logo-review' && logoReview?.active) return { kind: 'logo-review', state: logoReview }
  if (logoReview?.active) return { kind: 'logo-review', state: logoReview }
  if (selfEvolve?.active) return { kind: 'self-evolve', state: selfEvolve }
  if (contextSetup?.active) return { kind: 'context-setup', state: contextSetup }
  if (extension?.active) return { kind: 'extension', state: extension }
  if (projectImport?.active) return { kind: 'project-import', state: projectImport }
  if (birthday?.active) return { kind: 'birthday', state: birthday }
  return null
}

export function patchGuidedDemoState(kind: GuidedDemoKind, patch: Partial<GuidedDemoState>) {
  if (kind === 'birthday') patchBirthdayDemoState(patch as Partial<BirthdayDemoState>)
  else if (kind === 'project-import') patchProjectImportDemoState(patch as Partial<ProjectImportDemoState>)
  else if (kind === 'context-setup') patchContextSetupDemoState(patch as Partial<ContextSetupDemoState>)
  else if (kind === 'self-evolve') patchSelfEvolveDemoState(patch as Partial<SelfEvolveDemoState>)
  else if (kind === 'extension') patchExtensionDemoState(patch as Partial<ExtensionDemoState>)
  else patchLogoReviewDemoState(patch as Partial<LogoReviewDemoState>)
}

export function isGuidedDemoProject(projectId?: string) {
  return isBirthdayDemoProject(projectId) || isProjectImportDemoProject(projectId) || isContextSetupDemoProject(projectId) || isSelfEvolveDemoProject(projectId) || isExtensionDemoProject(projectId)
}

export function isGuidedDemoIssue(issueId?: string) {
  return isBirthdayDemoIssue(issueId) || isProjectImportDemoIssue(issueId) || isContextSetupDemoIssue(issueId) || isSelfEvolveDemoIssue(issueId) || isExtensionDemoIssue(issueId)
}

export function isGuidedDemoSession(sessionId?: string) {
  return isBirthdayDemoSession(sessionId) || isProjectImportDemoSession(sessionId) || isContextSetupDemoSession(sessionId) || isSelfEvolveDemoSession(sessionId) || isExtensionDemoSession(sessionId)
}

export function completeGuidedDemoStateForProject(projectId?: string) {
  if (isBirthdayDemoProject(projectId)) completeBirthdayDemoState()
  else if (isProjectImportDemoProject(projectId)) completeProjectImportDemoState()
  else if (isContextSetupDemoProject(projectId)) completeContextSetupDemoState()
  else if (isSelfEvolveDemoProject(projectId)) completeSelfEvolveDemoState()
  else if (isExtensionDemoProject(projectId)) completeExtensionDemoState()
  else if (isLogoReviewDemoCleanupProject(projectId)) completeLogoReviewDemoState()
}

export function patchGuidedDemoSessionCompleted(sessionId?: string) {
  if (isBirthdayDemoSession(sessionId)) patchBirthdayDemoState({ sessionCompletedAt: Date.now() })
  else if (isProjectImportDemoSession(sessionId)) patchProjectImportDemoState({ sessionCompletedAt: Date.now() })
  else if (isContextSetupDemoSession(sessionId)) patchContextSetupDemoState({ sessionCompletedAt: Date.now() })
  else if (isSelfEvolveDemoSession(sessionId)) patchSelfEvolveDemoState({ sessionCompletedAt: Date.now() })
  else if (isExtensionDemoSession(sessionId)) patchExtensionDemoState({ sessionCompletedAt: Date.now() })
}
