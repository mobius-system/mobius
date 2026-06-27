const ASSISTANT_SESSION_KEY_PREFIX = 'assistant-question';

function assistantSessionKeyPrefixForUser(userId: string): string {
  return `${ASSISTANT_SESSION_KEY_PREFIX}:${userId}:`;
}

function isAssistantSession(session: any, user: any = null): boolean {
  if (!session || typeof session.session_key !== 'string') return false;
  if (user?.id) {
    return session.user_id === user.id
      && session.session_key.startsWith(assistantSessionKeyPrefixForUser(user.id));
  }
  return session.session_key.startsWith(`${ASSISTANT_SESSION_KEY_PREFIX}:`);
}

function assistantSessionKeyLike(userId: string): string {
  return `${assistantSessionKeyPrefixForUser(userId)}%`;
}

export {
  ASSISTANT_SESSION_KEY_PREFIX,
  assistantSessionKeyLike,
  isAssistantSession,
};
