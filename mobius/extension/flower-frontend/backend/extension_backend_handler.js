/**
 * flower-frontend/backend/extension_backend_handler.js
 *
 * CommonJS handler for /api/ext. Keep it stateless and write only under ext_data_dir.
 */
const path = require('path');
const fs = require('fs/promises');

const STATE_FILE = 'state.json';

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const stateFile = path.join(ext_data_dir, STATE_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'save_note') {
    const note = typeof ext_main_payload.note === 'string' ? ext_main_payload.note.slice(0, 2000) : '';
    const state = await readState(stateFile);
    state[username] = { note, updated_at: Date.now() };
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    logger && logger.info && logger.info('save_note', { username });
    return { ok: true };
  }

  if (action === 'load_note') {
    const state = await readState(stateFile);
    return { ok: true, note: state[username]?.note || '' };
  }

  return { ok: true, message: 'Hello from flower-frontend', action: action || null };
};
