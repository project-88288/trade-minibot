'use strict';

// notifyLogger — mirror every console log to the notify-server sink.
//
// Wraps the global console.log/info/warn/error methods so that, in addition to
// their normal stdout/stderr output, each line is POSTed to the notify-server
// (see NOTIFY_URL) as a structured event:
//   { level, source, message }
// Levels map log/info → INFO, warn → WARN, error → ERROR.
//
// Delivery is fire-and-forget and fully non-blocking: the bot never waits on
// the notify-server, and any delivery failure is swallowed so a down or slow
// sink can never crash or stall trading. If NOTIFY_URL is unset the module is a
// no-op and console behaves exactly as before.

const axios = require('axios');

let installed = false;

// Format console.* varargs the way console itself would render them, so the
// forwarded message matches what's printed to the terminal.
function render(args) {
  const util = require('util');
  return util.format(...args);
}

function install(url, source) {
  if (installed) return;
  if (!url) return; // notify disabled — leave console untouched
  installed = true;

  const base = url.replace(/\/+$/, '');
  const endpoint = `${base}/notify`;
  const src = source || 'ftrade-bot';

  // Reuse one keep-alive client with a short timeout so a hung sink can't pile
  // up sockets or delay the process.
  const client = axios.create({ baseURL: base, timeout: 3000 });

  function forward(level, message) {
    // Cap message size well under the server's 64 KB body limit.
    const msg = message.length > 8000 ? message.slice(0, 8000) + '…[truncated]' : message;
    client
      .post('/notify', { level, source: src, message: msg })
      .catch(() => { /* sink down/slow — never let it affect the bot */ });
  }

  const orig = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => { orig.log(...args);   forward('INFO',  render(args)); };
  console.info = (...args) => { orig.info(...args);  forward('INFO',  render(args)); };
  console.warn = (...args) => { orig.warn(...args);  forward('WARN',  render(args)); };
  console.error = (...args) => { orig.error(...args); forward('ERROR', render(args)); };

  // Announce over the same channel so the sink records that forwarding is live.
  console.log(`[NOTIFY] Forwarding logs to ${endpoint} (source=${src})`);
}

module.exports = { install };
