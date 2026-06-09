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

// Writes optimizer-sourced strategy params back into .env so they survive a
// restart even when the optimizer is temporarily unreachable.
function saveParamsToEnv(params) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');

  for (const [key, envVar] of Object.entries(PARAM_MAP)) {
    if (params[key] == null) continue;
    const re = new RegExp(`^(${envVar}=).*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `$1${params[key]}`);
    } else {
      text += `\n${envVar}=${params[key]}`;
    }
  }

  fs.writeFileSync(ENV_PATH, text, 'utf8');
  console.log('[PARAMS] Optimizer params saved to .env as fallback backup');
}

module.exports = { saveParamsToEnv };
