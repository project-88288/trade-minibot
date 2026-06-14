'use strict';

// Manually closes whatever position is currently open on KuCoin Futures
// for the configured SYMBOL. Cancels any resting TP/SL orders first, then
// sends a reduceOnly market order (BUY to close a short, SELL to close a
// long). Run with: node close-position.js

require('dotenv').config();

const config             = require('./config');
const { KuCoinClient }   = require('./src/kucoinExchange');

async function main() {
  if (config.exchange !== 'kucoin') {
    console.error(`EXCHANGE=${config.exchange} — this script only supports kucoin`);
    process.exit(1);
  }

  const exchange = new KuCoinClient({
    apiKey:         config.kucoinApiKey,
    apiSecret:      config.kucoinApiSecret,
    passphrase:     config.kucoinApiPassphrase,
    symbolOverride: config.kucoinSymbol,
    marginMode:     config.kucoinMarginMode,
    leverage:       config.leverage,
  });

  const position = await exchange.getPosition(config.symbol);
  if (!position) {
    console.log(`No open position for ${config.symbol}`);
    return;
  }

  console.log(`Open ${position.side.toUpperCase()} position: qty=${position.qty} entry=${position.entryPrice}`);

  await exchange.cancelAllOrders(config.symbol);

  const exitSide = position.side === 'long' ? 'SELL' : 'BUY';
  const { avgPrice } = await exchange.exitMarket(config.symbol, exitSide, position.qty);

  console.log(`Closed ${position.side.toUpperCase()} ${config.symbol} @ ${avgPrice}`);
}

main().catch(e => {
  console.error('Close failed:', e.message);
  process.exit(1);
});
