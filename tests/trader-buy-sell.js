require('dotenv').config();
const { BinanceClient } = require('../src/exchange');
const { Trader } = require('../src/trader');

// Exercises Trader.enter() end-to-end against the real Binance Futures
// account: places a market entry for `side` on SYMBOL with TRADE_CAPITAL
// USDT, then relies on Trader's own _syncProtectiveOrders() to place the
// exchange-native TP/SL via the Algo Order API. Position is left open.
//
// Usage: node tests/trader-buy-sell.js long|short

(async () => {
  const side = process.argv[2];
  if (side !== 'long' && side !== 'short') {
    console.error('Usage: node tests/trader-buy-sell.js long|short');
    process.exit(1);
  }

  // Hardcoded to avoid touching SYMBOL (LUNA2USDT), which has a live bot
  // position open.
  const symbol = 'XRPUSDT';

  const exchange = new BinanceClient({
    apiKey:      process.env.BINANCE_API_KEY,
    apiSecret:   process.env.BINANCE_SECRET_KEY,
    futuresMode: true,
  });

  const trader = new Trader({
    exchange,
    symbol,
    tradeCapital:     parseFloat(process.env.TRADE_CAPITAL),
    tradePercent:     0,
    tradeFee:         parseFloat(process.env.TRADE_FEE),
    stopLossPercent:  parseFloat(process.env.STOP_LOSS_PERCENT),
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT),
    trailingPercent:  parseFloat(process.env.TRAILING_PERCENT),
    futuresMode:      true,
  });

  await trader.enter(side);

  console.log('position:', trader.position);
  console.log('syncedTp:', trader.syncedTp, 'syncedSl:', trader.syncedSl);

  const open = await exchange._request('GET', '/fapi/v1/openAlgoOrders', { symbol, recvWindow: 10000 }, true);
  console.log('open algo orders for', symbol, ':', JSON.stringify(open.algoOrders || open, null, 2));
})().catch(e => console.error(e.message));
