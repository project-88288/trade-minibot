'use strict';

// Opens a REAL short position on KuCoin Futures using the credentials and
// settings from .env. This affects real funds — use with care.
//
// Usage:
//   node tests/kucoin-short.js [symbol] [quoteCapital]
//
// Examples:
//   node tests/kucoin-short.js                # uses SYMBOL/TRADE_CAPITAL from .env
//   node tests/kucoin-short.js BTCUSDT 10      # short ~10 USDT of BTCUSDT-equivalent

require('dotenv').config();
const path = require('path');
const { KuCoinClient } = require(path.join(__dirname, '..', 'src', 'kucoinExchange.js'));

async function main() {
  const symbol = process.argv[2] || process.env.SYMBOL || 'BTCUSDT';
  const quoteCapital = parseFloat(process.argv[3] || process.env.TRADE_CAPITAL || '10');

  const client = new KuCoinClient({
    apiKey:         process.env.KUCOIN_API_KEY,
    apiSecret:      process.env.KUCOIN_API_SECRET,
    passphrase:     process.env.KUCOIN_API_PASSPHRASE,
    symbolOverride: process.env.KUCOIN_SYMBOL || undefined,
    marginMode:     process.env.KUCOIN_MARGIN_MODE || 'CROSS',
    leverage:       parseFloat(process.env.LEVERAGE || '1'),
  });

  console.log(`Placing market SHORT (sell) for ${quoteCapital} USDT on ${symbol}...`);
  const result = await client.enterMarket(symbol, 'sell', quoteCapital);
  console.log('Order filled:', result);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
