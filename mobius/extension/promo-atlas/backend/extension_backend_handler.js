/**
 * promo-atlas/backend/extension_backend_handler.js
 *
 * 这是一个纯静态调研型 extension, 前端不需要后端数据.
 * handler 只暴露一个 meta action 用于健康检查与回显身份.
 */
module.exports = async function promoAtlasHandler({
  username,
  display_name,
  ext_main_payload,
}) {
  const action = ext_main_payload && ext_main_payload.action;

  if (action === 'meta' || action === undefined) {
    return {
      ok: true,
      extension: 'promo-atlas',
      version: '0.1.0',
      username,
      display_name: display_name || username,
      sections: 7,
      generated_at: '2026-06-27',
    };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
