'use strict';

// Places exchange-native TP/SL stop orders for whatever position is
// currently open on KuCoin Futures for the configured SYMBOL. TP/SL
// percentages come from TAKE_PROFIT_PERCENT / STOP_LOSS_PERCENT in .env,
// applied to the position's entry price the same way Trader.enter() does.
// Run with: node set-stops.js

require('dotenv').config();

const config           = require('./config');
const { KuCoinClient } = require('./src/kucoinExchange');

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

  const { side, entryPrice, qty } = position;
  const isLong = side === 'long';
  const takeProfitPrice = entryPrice * (isLong ? 1 + config.takeProfitPercent / 100 : 1 - config.takeProfitPercent / 100);
  const stopLossPrice   = entryPrice * (isLong ? 1 - config.stopLossPercent / 100   : 1 + config.stopLossPercent / 100);

  const [epFmt, tpFmt, slFmt] = await Promise.all([
    exchange.formatPrice(config.symbol, entryPrice),
    exchange.formatPrice(config.symbol, takeProfitPrice),
    exchange.formatPrice(config.symbol, stopLossPrice),
  ]);
  console.log(
    `Open ${side.toUpperCase()} position: qty=${qty} entry=${epFmt}\n` +
    `Setting TP=${tpFmt} (${config.takeProfitPercent}%)  SL=${slFmt} (${config.stopLossPercent}%)`
  );

  await exchange.cancelAllOrders(config.symbol);
  await exchange.placeFuturesStopOrders(config.symbol, { side, takeProfitPrice, stopLossPrice });

  console.log('TP/SL orders placed.');
}

main().catch(e => {
  console.error('Set stops failed:', e.message);
  process.exit(1);
});
