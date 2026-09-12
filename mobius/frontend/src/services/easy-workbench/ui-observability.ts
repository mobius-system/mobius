export type UiEventName =
  | 'home_arrived'
  | 'research_home_arrived'
  | 'creation_home_arrived'
  | 'project_created'
  | 'first_message_submitted'
  | 'research_first_message_submitted'
  | 'creation_first_message_submitted'
  | 'history_opened'
  | 'settings_opened'
  | 'advanced_opened'

export function logUiEvent(event: UiEventName, detail: Record<string, unknown> = {}) {
  if (typeof console === 'undefined') return
  console.debug('[mobius-ui]', event, { ...detail, at: new Date().toISOString() })
}
