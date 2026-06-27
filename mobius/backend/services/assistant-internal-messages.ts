const ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX = '[[mobius:assistant-internal-notification-prompt]]';

function markAssistantInternalNotificationPrompt(content: any): string {
  return `${ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX}\n${String(content || '')}`;
}

export {
  ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX,
  markAssistantInternalNotificationPrompt,
};
