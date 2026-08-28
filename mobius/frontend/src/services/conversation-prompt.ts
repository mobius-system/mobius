export type ConversationPromptAttachment = {
  path: string
  kind?: 'image' | 'file'
}

export function composeConversationPrompt(
  prompt: string,
  attachments: ConversationPromptAttachment[] = [],
): string {
  const text = prompt.trim()
  const attachmentLines = attachments
    .map(attachment => ({ ...attachment, path: String(attachment.path || '').trim() }))
    .filter(attachment => attachment.path)
    .map(attachment => `- [${attachment.kind === 'file' ? '文件' : '图片'}] ${attachment.path}`)
  const attachmentBlock = attachmentLines.length > 0 ? `[附件]\n${attachmentLines.join('\n')}` : ''
  return [attachmentBlock, text].filter(Boolean).join('\n\n')
}
