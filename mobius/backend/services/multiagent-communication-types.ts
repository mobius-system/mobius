// multiagent-communication-types.ts — @ 提及模式类型 (独立成文件避免环状 import:
// mention-context ↔ multiagent-communication 互相引用时, 类型从这里单向出入).
export type AgentMentionMode = 'read_only' | 'bidirectional';
