// This extension is intentionally frontend-only. The registry requires a handler,
// so keep it stateless and return a harmless health response only.
module.exports = async function ({ extension_name }) {
  return { ok: true, extension_name, frontend_only: true };
};
