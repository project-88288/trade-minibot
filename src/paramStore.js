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

// Backtest-result keys written to .env after every gate/backtest run, so the
// latest result is inspectable and survives a restart. All are locally computed
// numbers except `at`, an ISO timestamp of when the backtest ran.
const BACKTEST_MAP = {
  candleLength: 'BACKTEST_CANDLE_LENGTH',
  annualReturn: 'BACKTEST_ANNUAL_RETURN',
  totalPnl:     'BACKTEST_TOTAL_PNL',
  winRate:      'BACKTEST_WIN_RATE',
  maxDD:        'BACKTEST_MAX_DD',
  finalCapital: 'BACKTEST_FINAL_CAPITAL',
  total:        'BACKTEST_TRADES',
  at:           'BACKTEST_AT',
};

// Coerces a value into a safe .env value. Optimizer params come from a remote
// service, so a compromised/spoofed optimizer must not be able to inject extra
// .env lines (e.g. a value containing a newline overwriting BINANCE_API_SECRET).
// Numbers pass through; `interval` must match a simple timeframe pattern; `at`
// must match an ISO-8601 timestamp; anything else is rejected.
function sanitizeValue(key, value) {
  if (key === 'interval') {
    return /^[0-9]+[smhdwM]$/.test(value) ? String(value) : null;
  }
  if (key === 'at') {
    return /^[0-9T:.\-]+Z$/.test(value) ? String(value) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

// Upserts each key of `values` into .env using its mapped env-var name,
// skipping null/undefined and any value that fails sanitization.
function writeEnvVars(map, values, label) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');

  for (const [key, envVar] of Object.entries(map)) {
    if (values[key] == null) continue;
    const value = sanitizeValue(key, values[key]);
    if (value == null) {
      console.warn(`[${label}] Ignoring unsafe value for ${envVar}: ${JSON.stringify(values[key])}`);
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
}

// Writes optimizer-sourced strategy params back into .env so they survive a
// restart even when the optimizer is temporarily unreachable.
function saveParamsToEnv(params) {
  writeEnvVars(PARAM_MAP, params, 'PARAMS');
  console.log('[PARAMS] Optimizer params saved to .env as fallback backup');
}

// Writes the latest backtest summary (candle length, annualized return / ROA,
// PnL, win rate, drawdown, final capital, trade count) into .env.
function saveBacktestToEnv(summary) {
  writeEnvVars(BACKTEST_MAP, { ...summary, at: new Date().toISOString() }, 'BACKTEST');
  console.log('[BACKTEST] Result saved to .env');
}

module.exports = { saveParamsToEnv, saveBacktestToEnv };
