export type PcWorkMode = 'hub' | 'pc' | 'dual';
export type ContextLanguage = 'zh' | 'en';

export interface PcClientMetadata {
  work_mode?: PcWorkMode;
  aimux_id?: string;
  local_path?: string;
  /**
   * Client-type marker, only present on PC task-mode sessions.
   *   true  = Mobius TUI (the TUI client always writes this with work_mode:'pc').
   *   false = Electron desktop client with PC task mode active.
   * NOTE on the 3-way contract: web sessions — and Electron desktop *without*
   * PC task mode — carry NO pc_client_metadata at all, so this field is ABSENT
   * (the DB column is null), NOT `false`. Therefore `is_tui === false` reliably
   * means "Electron + PC mode", and you MUST NOT treat `!is_tui` /
   * `is_tui === false` as "web": web is identified by a null pc_client_metadata,
   * not by a falsy is_tui. All consumers branch on `is_tui === true` (positive)
   * and let absence fall through the null-meta early-return.
   */
  is_tui?: boolean;
  /**
   * Explicit opt-in for the aimux remote_* MCP toolset. The Mobius TUI sets this
   * to true alongside is_tui. aimuxRemoteNameFromMeta gates MCP injection on
   * this flag (not is_tui alone), so the feature is opt-in per session.
   */
  add_remote_aimux_mcp?: boolean;
}

export function parsePcClientMetadata(raw: unknown): PcClientMetadata | null {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' ? parsed as PcClientMetadata : null;
}

/**
 * For client sessions that explicitly opted into the aimux remote_* MCP
 * toolset (add_remote_aimux_mcp === true) and are bound to an aimux remote,
 * return that remote name (aimux_id); otherwise undefined.  TUI and Electron
 * use the same per-session protocol; the explicit flag keeps web sessions
 * unchanged and prevents accidental MCP injection.
 * Used to gate per-session MCP injection when spawning codex / claude-code.
 */
export function aimuxRemoteNameFromMeta(raw: unknown): string | undefined {
  const meta = parsePcClientMetadata(raw);
  if (
    meta?.add_remote_aimux_mcp === true &&
    typeof meta.aimux_id === 'string' &&
    meta.aimux_id.trim()
  ) {
    return meta.aimux_id.trim();
  }
  return undefined;
}

/** TUI always needs the operating guide; Electron needs it only in pc/dual mode. */
export function pcClientRequiresAimuxSkill(raw: unknown): boolean {
  const meta = parsePcClientMetadata(raw);
  if (!meta) return false;
  return meta.is_tui === true || meta.work_mode === 'pc' || meta.work_mode === 'dual';
}

function pathClause(meta: PcClientMetadata, language: ContextLanguage): string {
  const localPath = typeof meta.local_path === 'string' ? meta.local_path.trim() : '';
  if (!localPath || meta.work_mode === 'hub') return '';
  return language === 'en'
    ? `. The working directory on that remote machine is: \`${localPath}\``
    : `。该远程机器上的工作目录为：\`${localPath}\``;
}

export function pcTaskModePrompt(raw: unknown, language: ContextLanguage): string {
  const meta = parsePcClientMetadata(raw);
  const mode = meta?.work_mode;
  const aimuxId = typeof meta?.aimux_id === 'string' ? meta.aimux_id.trim() : '';
  if (!meta || !mode || !['hub', 'pc', 'dual'].includes(mode) || !aimuxId) return '';

  const remotePath = pathClause(meta, language);

  return pcTaskModePromptFor(meta, language, mode, aimuxId, remotePath);
}

type ClientKind = 'tui' | 'desktop';

/** Builds one mode-instruction given the remote id and working-dir clause. */
type ModePrompt = (aimuxId: string, remotePath: string) => string;

/** Fixed orientation paragraph prepended to every TUI prompt. */
function tuiBasePrompt(aimuxId: string, remotePath: string, language: ContextLanguage): string {
  // One template literal per sentence, joined with `+`, so the value stays single-line.
  return language === 'en'
    ? `You are working at remote machine ${aimuxId}${remotePath}. ` +
      `I'm working in this remote machine as well, so when I say 'here', I mean remote path [${remotePath}] at ${aimuxId}. ` +
      `When I say 'local', I also mean ${aimuxId}. ` +
      `Only when I say 'mobius center/hub' do I mean the machine you are currently on. ` +
      `You operate this remote computer through the remote_* MCP tools (remote_exec_command, remote_write_stdin, remote_apply_patch, remote_view_image, remote_ping); ` +
      `these tools act directly on ${aimuxId} — the computer whose hostname is encoded in that identifier. ` +
      `In your text answer, do not mention 'aimux' or reveal that you are working remotely (although in fact you are working remotely).`
    : `你在远程机器 ${aimuxId}${remotePath} 上工作。` +
      `由于我也正在远程机器上操作，所以当我说“这里(here)”时，我指的是 ${aimuxId} 上的远程路径 [${remotePath}]；` +
      `当我说“本地(local)”时，我指的是 ${aimuxId}。` +
      `只有当我说“中枢(mobius center/hub)”时，才指现在你所处的机器。` +
      `你优先使用已注册的 MCP 工具（remote_exec_command、remote_write_stdin、remote_apply_patch、remote_view_image、remote_ping）操作这台远程计算机；` +
      `这些工具直接作用于 ${aimuxId} —— 该标识符编码了其主机名的那台计算机。` +
      `在你的文本回答中，不要提及“aimux”，也不要暴露你在远程工作（尽管实际上你在远程工作）。`;
}

/** Closing half of the 'dual' instruction, identical for both clients. */
function dualModeTail(aimuxId: string, remotePath: string, language: ContextLanguage): string {
  return language === 'en'
    ? `When you need to modify code, first modify the local code, then sync all the code to ${aimuxId}, unless the user objects. ` +
      `When the user asks you to run code, follow the same rule. ` +
      `Remote path you are allowed to operate is: ${remotePath}.`
    : `当你需要修改代码时，先修改本地的代码，然后把代码都要同步到${aimuxId}上，除非用户反对你这样做。` +
      `当用户需要你运行代码时，遵循一样的规则，可操作远程路径${remotePath}。`;
}

/**
 * Per client × mode × language instruction. The TUI reaches the remote through
 * the remote_* MCP tools; the Electron desktop client reaches it through aimux.
 */
const MODE_PROMPTS: Record<ClientKind, Record<PcWorkMode, Record<ContextLanguage, ModePrompt>>> = {
  tui: {
    hub: {
      en: (id) => `Do not use the remote_* tools to operate the following remote machine: ${id}. Work in the Mobius Hub (that is, locally).`,
      zh: (id) => `不要使用 remote_* 工具操作以下远程机器： ${id}，在mobius中枢（即本地）工作`,
    },
    pc: {
      en: (id, rp) =>
        `Carry out all work on the following remote machine via the remote_* tools: ${id}${rp}. ` +
        `When you need to modify documents, first sync the project to the Mobius Hub (that is, locally), ` +
        `then immediately sync every change back to the path specified by ${id}, unless the user objects. ` +
        `If the user objects, read or modify files directly through the remote_* tools.`,
      zh: (id, rp) =>
        `通过 remote_* 工具在以下远程机器上执行所有工作：${id}${rp}。` +
        `当你需要修改文档时，先将项目同步到mobius中枢（即本地），每次修改后都立即同步回到 ${id} 指定路径，除非用户反对你这样做。` +
        `如果用户反对，直接通过 remote_* 工具读取或修改文件。`,
    },
    dual: {
      en: (id, rp) =>
        `You are authorized to operate the following remote machine via the remote_* tools: ${id}. ` +
        dualModeTail(id, rp, 'en'),
      zh: (id, rp) =>
        `你现在被授权通过 remote_* 工具操作以下远程机器： ${id}，` +
        dualModeTail(id, rp, 'zh'),
    },
  },
  desktop: {
    hub: {
      en: (id) => `Do not use aimux to connect to the following remote machine: ${id}`,
      zh: (id) => `不要使用aimux连接到以下远程机器： ${id}`,
    },
    pc: {
      en: (id, rp) =>
        `Use the registered remote_* MCP tools (backed by aimux) to connect to the following remote machine and carry out all work, ` +
        `and try to avoid modifying local code: ${id}${rp}`,
      zh: (id, rp) => `使用已注册的 remote_* MCP 工具（由 aimux 提供）连接到以下远程机器执行所有工作，尽量不修改本地的代码： ${id}${rp}`,
    },
    dual: {
      en: (id, rp) =>
        `You are authorized to use the registered remote_* MCP tools (backed by aimux) to connect to the following remote machine: ${id}. ` +
        dualModeTail(id, rp, 'en'),
      zh: (id, rp) =>
        `你现在被授权使用已注册的 remote_* MCP 工具（由 aimux 提供）连接到以下远程机器： ${id}，` +
        dualModeTail(id, rp, 'zh'),
    },
  },
};

/** Look up the per-mode instruction and glue it to the client-specific base. */
function pcTaskModePromptFor(
  meta: PcClientMetadata,
  language: ContextLanguage,
  mode: PcWorkMode,
  aimuxId: string,
  remotePath: string,
): string {
  const client: ClientKind = meta.is_tui === true ? 'tui' : 'desktop';
  const lang: ContextLanguage = language === 'en' ? 'en' : 'zh';
  const modePrompt = MODE_PROMPTS[client][mode][lang](aimuxId, remotePath);
  return client === 'tui'
    ? `${tuiBasePrompt(aimuxId, remotePath, lang)}\n${modePrompt}`
    : modePrompt;
}
