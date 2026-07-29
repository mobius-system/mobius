export type PcWorkMode = 'hub' | 'pc' | 'dual';
export type ContextLanguage = 'zh' | 'en';

export interface PcClientMetadata {
  work_mode?: PcWorkMode;
  aimux_id?: string;
  local_path?: string;
  /** true = Mobius TUI; false = Electron desktop client. */
  is_tui?: boolean;
}

export function parsePcClientMetadata(raw: unknown): PcClientMetadata | null {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' ? parsed as PcClientMetadata : null;
}

/**
 * For Mobius TUI sessions (is_tui === true) bound to an aimux remote, return
 * that remote name (aimux_id); otherwise undefined. Used to gate per-session
 * MCP injection when spawning codex.
 */
export function aimuxRemoteNameFromMeta(raw: unknown): string | undefined {
  const meta = parsePcClientMetadata(raw);
  if (meta?.is_tui === true && typeof meta.aimux_id === 'string' && meta.aimux_id.trim()) {
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
    ? `. The working directory on that remote object is: \`${localPath}\``
    : `。该远程对象上的工作目录为：\`${localPath}\``;
}

export function pcTaskModePrompt(raw: unknown, language: ContextLanguage): string {
  const meta = parsePcClientMetadata(raw);
  const mode = meta?.work_mode;
  const aimuxId = typeof meta?.aimux_id === 'string' ? meta.aimux_id.trim() : '';
  if (!meta || !mode || !['hub', 'pc', 'dual'].includes(mode) || !aimuxId) return '';

  const remotePath = pathClause(meta, language);

  // TUI client
  let tuiPrompt = `You are working at remote machine ${aimuxId}${remotePath}. When I say 'here', I mean remote path [${remotePath}] at ${aimuxId}. When I say 'local', I mean ${aimuxId}. In your text answer, do not mention 'aimux' to avoid confusion, but you can use 'aimux' as a tool without limitation. Do not mention to user you are working remotely (although in fact you are working remotely).`;
  let modePrompt = ``;
  if (meta.is_tui === true) {
    if (language === 'en') {
      if (mode === 'hub') {
        modePrompt = `Do not use aimux to connect to the following remote object: ${aimuxId}. Work in the Mobius Hub (that is, locally).`;
      } else if (mode === 'pc') {
        modePrompt = `Use aimux to connect to the following remote object to carry out all work: ${aimuxId}${remotePath}. When you need to modify documents, first sync the project to the Mobius Hub (that is, locally), then immediately sync every change back to the path specified by ${aimuxId}, unless the user objects. If the user objects, read or modify files directly through aimux commands.`;
      } else {
        modePrompt = `You are authorized to use aimux to connect to the following remote object: ${aimuxId}. When you need to modify code, first modify the local code, then sync all the code to ${aimuxId}, unless the user objects. When the user asks you to run code, follow the same rule. Remote path you are allowed to operate is: ${remotePath}.`;
      }
    } else {
      if (mode === 'hub') {
        modePrompt = `不要使用aimux连接到以下远程对象： ${aimuxId}，在mobius中枢（即本地）工作`;
      } else if (mode === 'pc') {
        modePrompt = `使用aimux连接到以下远程对象执行所有工作：${aimuxId}${remotePath}。当你需要修改文档时，先将项目同步到mobius中枢（即本地），每次修改后都立即同步回到 ${aimuxId} 指定路径，除非用户反对你这样做。如果用户反对，直接通过aimux命令读取或修改文件`;
      } else {
        modePrompt = `你现在被授权使用aimux连接到以下远程对象： ${aimuxId}，当你需要修改代码时，先修改本地的代码，然后把代码都要同步到${aimuxId}上，除非用户反对你这样做。当用户需要你运行代码时，遵循一样的规则，可操作远程路径${remotePath}。`;
      }
    }
    return `${tuiPrompt}\n${modePrompt}`;
  }


  // PC mobius (electron desktop)
  if (language === 'en') {
    if (mode === 'hub') {
      return `Do not use aimux to connect to the following remote object: ${aimuxId}`;
    }
    if (mode === 'pc') {
      return `Use aimux to connect to the following remote object to carry out all work, and try to avoid modifying local code: ${aimuxId}${remotePath}`;
    }
    return `You are authorized to use aimux to connect to the following remote object: ${aimuxId}. When you need to modify code, first modify the local code, then sync all the code to ${aimuxId}, unless the user objects. When the user asks you to run code, follow the same rule. Remote path you are allowed to operate is: ${remotePath}.`;
  } else {
    if (mode === 'hub') {
      return `不要使用aimux连接到以下远程对象： ${aimuxId}`;
    }
    if (mode === 'pc') {
      return `使用aimux连接到以下远程对象执行所有工作，尽量不修改本地的代码： ${aimuxId}${remotePath}`;
    }
    return `你现在被授权使用aimux连接到以下远程对象： ${aimuxId}，当你需要修改代码时，先修改本地的代码，然后把代码都要同步到${aimuxId}上，除非用户反对你这样做。当用户需要你运行代码时，遵循一样的规则，可操作远程路径${remotePath}。`;
  }
}
