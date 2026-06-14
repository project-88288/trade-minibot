require('dotenv').config();
const { UMFutures } = require('@binance/futures-connector');

const client = new UMFutures(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_SECRET_KEY
);

// Rounds `value` to the nearest multiple of `tick`, formatted to the same
// number of decimals as `tick` (Binance rejects prices with extra precision).
function roundToTick(value, tick) {
  const decimals = (tick.toString().split('.')[1] || '').length;
  const rounded  = Math.round(value / tick) * tick;
  return rounded.toFixed(decimals);
}

// Rounds `value` down to a multiple of `step` (Binance LOT_SIZE), formatted
// to the same number of decimals as `step`.
function roundDownToStep(value, step) {
  const decimals = (step.toString().split('.')[1] || '').length;
  const rounded  = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}

async function openShortWithTPSL({
  symbol,
  quantity,
  takeProfit,
  stopLoss
}) {
  // Open SHORT
  await client.newOrder(
    symbol,
    'SELL',
    'MARKET',
    {
      quantity
    }
  );

  // TP (buy back lower)
  await client.newOrder(
    symbol,
    'BUY',
    'TAKE_PROFIT_MARKET',
    {
      stopPrice: takeProfit,
      closePosition: 'true',
      workingType: 'MARK_PRICE'
    }
  );

  // SL (buy back higher)
  await client.newOrder(
    symbol,
    'BUY',
    'STOP_MARKET',
    {
      stopPrice: stopLoss,
      closePosition: 'true',
      workingType: 'MARK_PRICE'
    }
  );

  console.log('SHORT opened with TP & SL');
}

(async () => {
  const symbol = 'DOGEUSDT';

  const { data: info } = await client.getExchangeInfo();
  const symInfo = info.symbols.find(s => s.symbol === symbol);
  const tickSize = parseFloat(symInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize);
  const stepSize = parseFloat(symInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);

  const { data: ticker } = await client.getPriceTicker(symbol);
  const price = parseFloat(ticker.price);

  const tpPct = parseFloat(process.env.TAKE_PROFIT_PERCENT) / 100;
  const slPct = parseFloat(process.env.STOP_LOSS_PERCENT) / 100;
  const tradeCapital = parseFloat(process.env.TRADE_CAPITAL);

  await openShortWithTPSL({
    symbol,
    quantity: roundDownToStep(tradeCapital / price, stepSize),
    takeProfit: roundToTick(price * (1 - tpPct), tickSize),
    stopLoss: roundToTick(price * (1 + slPct), tickSize)
  });
})();
