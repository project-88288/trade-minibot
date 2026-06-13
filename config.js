'use strict';

require('dotenv').config();

module.exports = {
  apiKey:    process.env.BINANCE_API_KEY    || '',
  apiSecret: process.env.BINANCE_API_SECRET || '',

  symbol:      process.env.SYMBOL       || 'BTCUSDT',
  futuresMode: process.env.FUTURES_MODE === 'true',

  tradeCapital: parseFloat(process.env.TRADE_CAPITAL || '100'),
  tradePercent: parseFloat(process.env.TRADE_PERCENT || '0'),

  optimizerUrl: process.env.OPTIMIZER_URL || 'http://localhost:4500',
  optimizerKey: process.env.OPTIMIZER_KEY || '',
  exchange:     process.env.EXCHANGE       || 'binance',

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
