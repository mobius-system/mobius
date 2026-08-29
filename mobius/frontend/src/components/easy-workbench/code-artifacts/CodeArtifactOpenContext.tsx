import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { CodeArtifactOpenRequest } from './file-target'

export type CodeArtifactOpenContextValue = {
  openArtifact: (request: CodeArtifactOpenRequest) => void
}

export const CodeArtifactOpenContext = createContext<CodeArtifactOpenContextValue | null>(null)

export function CodeArtifactOpenProvider({
  onOpenArtifact,
  children,
}: {
  onOpenArtifact?: (request: CodeArtifactOpenRequest) => void
  children: ReactNode
}) {
  const value = useMemo(() => onOpenArtifact ? { openArtifact: onOpenArtifact } : null, [onOpenArtifact])
  return <CodeArtifactOpenContext.Provider value={value}>{children}</CodeArtifactOpenContext.Provider>
}

export function useCodeArtifactOpen() {
  return useContext(CodeArtifactOpenContext)
}
