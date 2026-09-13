// Required by the extension registry. This prototype has no backend operations.
module.exports = async function () {
  return { ok: false, error: '此扩展仅提供前端界面演示' };
};
