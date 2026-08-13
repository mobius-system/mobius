/**
 * The light publication is static. Keep the handler for extension registry
 * compatibility without introducing a second data surface.
 */
module.exports = async function mobiusHomeLightHandler({
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
