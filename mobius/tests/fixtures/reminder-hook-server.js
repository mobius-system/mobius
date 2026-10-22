/**
 * Fake backend for the session reminder hook tests.
 *
 * Records every request and replies with a configurable JSON body, so the tests
 * can assert what the hook command actually sent without starting Mobius.
 */

const http = require('http');

function defaultHandler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: '[reminder] target host is ppu; this call acts on the core host',
    },
  }));
}

/**
 * Start the fake endpoint on an ephemeral port.
 *
 * @param {{ handler?: Function, delayMs?: number }} [options]
 * @returns {Promise<{ port: number, baseUrl: string, requests: any[], close: Function, setHandler: Function, setDelayMs: Function }>}
 */
function startReminderServer(options = {}) {
  const state = {
    requests: [],
    handler: options.handler || defaultHandler,
    delayMs: Number(options.delayMs || 0),
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      setTimeout(() => {
        try {
          state.handler(req, res);
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
      }, state.delayMs);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        get requests() { return state.requests; },
        setHandler(fn) { state.handler = fn; },
        setDelayMs(ms) { state.delayMs = Number(ms) || 0; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startReminderServer };
