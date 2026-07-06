/**
 * extension-push.ts — 消息管线 → 远程推送的桥.
 *
 * 当 Mobius 消息管线产生"目标用户应看到的新消息"且该用户不在线(无 SSE)时, 调本扩展
 * handler 的 notify_user 动作 → handler 查该用户上报的设备令牌 → 经 JPush(聚合华为等
 * 厂商通道)下发, 让 App 即便被杀也能在状态栏收到.
 *
 * 设计: 全部 fire-and-forget + try/catch, 推送失败绝不影响消息主流程. 扩展未注册/未配置
 * 密钥/网络异常 → 仅 console.warn, 不抛. 每条调用在隔离 worker_thread 跑(handler stateless).
 *
 * 调用契约与客户端上报一致: username = users.id(JWT subject), 与 devices.json 的 key 对齐.
 */
import * as registry from './extension-registry';
import { invokeHandler } from './extension-invoker';
import { EXT_PUSH_ENABLED, EXT_PUSH_EXTENSION_NAME } from '../config';

function isEnabled(): boolean {
  return EXT_PUSH_ENABLED !== false;
}

const MAX_BODY_LEN = 200;

function truncate(text: string, max: number = MAX_BODY_LEN): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

interface PushInput {
  username: string;       // 目标用户 = users.id
  title?: string;         // 通知标题(会话名/群名)
  body: string;           // 通知正文(消息摘要)
  deepLink?: string;      // 客户端点击拉起, 如 momo://chat/<id>
}

/**
 * 给指定用户发一条推送. 调用方应已判断该用户离线(无 SSE).
 * 幂等容错: 扩展未注册 / 未配置 / 任意异常 → 仅 warn, 不抛.
 */
async function pushToUser(input: PushInput): Promise<void> {
  const username = String(input?.username || '').trim();
  const body = truncate(input?.body || '');
  if (!username || !body) return;
  if (!isEnabled()) return;

  const entry = registry.get(EXT_PUSH_EXTENSION_NAME);
  if (!entry) {
    // 扩展未部署/未注册 —— 静默(常见于还没装 momo-mobile 的环境), 不刷日志.
    return;
  }

  const ext_main_payload: Record<string, any> = { action: 'notify_user', body };
  if (input.title) ext_main_payload.title = input.title;
  if (input.deepLink) ext_main_payload.deepLink = input.deepLink;

  try {
    const result = await invokeHandler({
      entry,
      username,
      ext_main_payload,
    });
    if (result && result.__error) {
      console.warn(`[extension-push] notify_user ${username}: handler error=${result.__error}`);
    }
    // result.value = { ok, pushed, ... }; pushed:0 = 该用户无已注册设备(正常, 静默).
  } catch (e) {
    console.warn(`[extension-push] notify_user ${username} failed: ${(e as Error).message || e}`);
  }
}

export { pushToUser, isEnabled, truncate };
