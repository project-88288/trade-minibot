'use strict';

const fs   = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '..', '.env');

// Strategy keys that come from the optimizer and should be backed up to .env.
const PARAM_MAP = {
  interval:          'INTERVAL',
  fastMA:            'FAST_MA',
  slowMA:            'SLOW_MA',
  rsiPeriod:         'RSI_PERIOD',
  rsiThreshold:      'RSI_THRESHOLD',
  stopLossPercent:   'STOP_LOSS_PERCENT',
  takeProfitPercent: 'TAKE_PROFIT_PERCENT',
  trailingPercent:   'TRAILING_PERCENT',
  tradeFee:          'TRADE_FEE',
};

// Coerces an optimizer-sourced param into a safe .env value. Params come from
// a remote service, so a compromised/spoofed optimizer must not be able to
// inject extra .env lines (e.g. a value containing a newline overwriting
// BINANCE_API_SECRET). Numbers pass through; `interval` must match a simple
// timeframe pattern; anything else is rejected.
function sanitizeValue(key, value) {
  if (key === 'interval') {
    return /^[0-9]+[smhdwM]$/.test(value) ? String(value) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

// Writes optimizer-sourced strategy params back into .env so they survive a
// restart even when the optimizer is temporarily unreachable.
function saveParamsToEnv(params) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');

  for (const [key, envVar] of Object.entries(PARAM_MAP)) {
    if (params[key] == null) continue;
    const value = sanitizeValue(key, params[key]);
    if (value == null) {
      console.warn(`[PARAMS] Ignoring unsafe value for ${envVar}: ${JSON.stringify(params[key])}`);
      continue;
    }
    const re = new RegExp(`^(${envVar}=).*$`, 'm');
    // Use a function replacer so `$`/`$1` sequences in the value aren't
    // interpreted as replacement patterns.
    if (re.test(text)) {
      text = text.replace(re, (_m, prefix) => `${prefix}${value}`);
    } else {
      text += `\n${envVar}=${value}`;
    }
  }

  fs.writeFileSync(ENV_PATH, text, 'utf8');
  console.log('[PARAMS] Optimizer params saved to .env as fallback backup');
}

module.exports = { saveParamsToEnv };
