'use strict';

require('dotenv').config();

module.exports = {
  apiKey:    process.env.BINANCE_API_KEY    || '',
  apiSecret: process.env.BINANCE_API_SECRET || '',

  symbol: process.env.SYMBOL || 'BTCUSDT',
  // KuCoin support here is KuCoin Futures only, so it's always "futures mode"
  futuresMode: process.env.FUTURES_MODE === 'true' || process.env.EXCHANGE === 'kucoin',

  tradeCapital: parseFloat(process.env.TRADE_CAPITAL || '100'),
  tradePercent: parseFloat(process.env.TRADE_PERCENT || '0'),

  // Minimum backtest annualized return (ROA %, over the loaded candle history)
  // required for the bot to place new trades with the current params. Checked on
  // startup and after every param reload (optimizer 24h refresh / midnight restart).
  minAllowPercent: parseFloat(process.env.MIN_ALLOW_PERCENT || '500'),

  // Minimum number of historical candles to load before backtesting or live
  // trading. loadCandles() fills the buffer both backward (older history) and
  // forward (up to now) until it holds at least this many candles.
  minCandles: parseInt(process.env.MIN_CANDLES || '3000'),

  // Maximum candles kept in the rolling buffer. The window grows past
  // MIN_CANDLES as new candles arrive but is capped here — the oldest candles
  // drop off once the buffer reaches this size.
  maxCandles: parseInt(process.env.MAX_CANDLES || '10000'),

  // When true, refuse to start if the API key can withdraw funds (see the
  // startup [KEYCHECK]). Otherwise such issues are warnings only.
  strictKeyCheck: process.env.STRICT_KEY_CHECK === 'true',

  optimizerUrl: process.env.OPTIMIZER_URL || 'http://localhost:4500',
  optimizerKey: process.env.OPTIMIZER_KEY || '',
  exchange:     process.env.EXCHANGE       || 'binance',

  // Notify-server sink — when set, every console log is also POSTed to
  // ${NOTIFY_URL}/notify. Leave blank to disable forwarding.
  notifyUrl: process.env.NOTIFY_URL || '',

  // KuCoin Futures credentials (only used when EXCHANGE=kucoin)
  kucoinApiKey:        process.env.KUCOIN_API_KEY        || '',
  kucoinApiSecret:     process.env.KUCOIN_API_SECRET     || '',
  kucoinApiPassphrase: process.env.KUCOIN_API_PASSPHRASE || '',
  // Override the auto-derived KuCoin symbol (e.g. BTCUSDT → XBTUSDTM)
  kucoinSymbol:     process.env.KUCOIN_SYMBOL || '',
  // Margin mode for KuCoin Futures orders — must match the account setting
  kucoinMarginMode: process.env.KUCOIN_MARGIN_MODE || 'CROSS',
  leverage:         parseInt(process.env.LEVERAGE || '1'),

  // Strategy defaults — overridden by optimizer params on startup
  interval:          process.env.INTERVAL            || '5m',
  fastMA:            parseInt(process.env.FAST_MA    || '9'),
  slowMA:            parseInt(process.env.SLOW_MA    || '21'),
  rsiPeriod:         parseInt(process.env.RSI_PERIOD || '14'),
  rsiThreshold:      parseFloat(process.env.RSI_THRESHOLD      || '60'),
  stopLossPercent:   parseFloat(process.env.STOP_LOSS_PERCENT  || '2'),
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '4'),
  trailingPercent:   parseFloat(process.env.TRAILING_PERCENT   || '0'),
  tradeFee:          parseFloat(process.env.TRADE_FEE          || '0.1'),
};
