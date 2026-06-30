/**
 * mobius-publication/backend/extension_backend_handler.js
 *
 * 莫比乌斯 publication 冷备宣传页后端，主要用于：
 *   - whoami: 返回当前登录用户，前端用于在右上角展示身份徽标
 *
 * 宣传页本身是纯静态内容，所有文案、图片占位均在 frontend 中实现，
 * 因此 handler 保持最小化，遵守 stateless 约束。
 */
module.exports = async function mobiusPublicationHandler({
  username,
  display_name,
  ext_main_payload,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  if (action === 'whoami') {
    return {
      ok: true,
      username,
      display_name: display_name || username || '',
    };
  }
  return { ok: false, error: 'unknown action' };
};
