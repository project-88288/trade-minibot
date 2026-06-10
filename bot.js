'use strict';

require('dotenv').config();

const config                  = require('./config');
const { BinanceClient }       = require('./src/exchange');
const { Trader }              = require('./src/trader');
const { getLatestSignal }     = require('./src/strategy');
const { runBacktest }         = require('./src/backtest');
const { fetchBestParams }     = require('./src/optimizerClient');
const { saveParamsToEnv }     = require('./src/paramStore');

const BACKTEST_MODE     = process.argv.includes('--backtest');
const CANDLE_LIMIT      = 1500;
const PARAM_REFRESH_MS  = 24 * 60 * 60 * 1000; // 24 hours

// ── Load strategy params ──────────────────────────────────────────────────────
async function loadParams() {
  if (!config.optimizerKey) {
    console.log('[OPTIMIZER] OPTIMIZER_KEY not set — using .env params');
    return config;
  }
  try {
    console.log(`[OPTIMIZER] Fetching params from ${config.optimizerUrl} …`);
    const best = await fetchBestParams(
      config.optimizerUrl, config.optimizerKey,
      'binance', config.symbol, config.interval,
    );
    const params = { ...config, ...best };
    console.log(
      `[OPTIMIZER] Loaded (saved ${best.savedAt?.slice(0, 10)})` +
      `  fast=${params.fastMA} slow=${params.slowMA} rsi=${params.rsiPeriod}` +
      `  sl=${params.stopLossPercent}% tp=${params.takeProfitPercent}%` +
      `  trail=${params.trailingPercent}%` +
      `  winRate=${best.optimizerWinRate}% pnl=${best.optimizerPnl}%`
    );
    saveParamsToEnv(params);
    return params;
  } catch (e) {
    console.warn(`[OPTIMIZER] Could not load (${e.message}) — using .env params`);
    return config;
  }
}

// ── Backtest mode ─────────────────────────────────────────────────────────────
async function backtest(params, exchange) {
  console.log(`\n[BACKTEST] ${config.symbol} ${params.interval}  last ${CANDLE_LIMIT} candles`);
  console.log(`  fast=${params.fastMA} slow=${params.slowMA} rsiP=${params.rsiPeriod} rsiTh=${params.rsiThreshold}`);
  console.log(`  sl=${params.stopLossPercent}% tp=${params.takeProfitPercent}% trail=${params.trailingPercent}% fee=${params.tradeFee}%\n`);

  const candles = await exchange.fetchCandles(config.symbol, params.interval, CANDLE_LIMIT);
  const { trades, summary: s } = runBacktest(candles, params);

  console.log('── Summary ────────────────────────────────────────');
  console.log(`  Trades   : ${s.total} (${s.wins}W / ${s.losses}L)  WinRate: ${s.winRate}%`);
  console.log(`  PnL      : ${s.totalPnl}%  MaxDD: ${s.maxDD}%`);
  console.log(`  Capital  : $100 → $${s.finalCapital}`);
  console.log('───────────────────────────────────────────────────');

  if (trades.length) {
    console.log('\nTrade log:');
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const pnlStr = (t.netPnl >= 0 ? '+' : '') + t.netPnl + '%';
      console.log(
        `  ${String(i + 1).padStart(3)}.` +
        ` ${t.side.padEnd(5)}` +
        `  in  ${t.entryTime.slice(0, 16)} @ ${t.entryPrice}` +
        `  out ${t.exitTime.slice(0, 16)} @ ${t.exitPrice}` +
        `  ${pnlStr.padStart(8)}  [${t.exitReason}]`
      );
    }
  }
}

// ── 24-hour param refresh ─────────────────────────────────────────────────────
async function refreshParams(params, trader) {
  if (!config.optimizerKey) return;
  try {
    console.log('[OPTIMIZER] 24h refresh — fetching new params …');
    const best = await fetchBestParams(
      config.optimizerUrl, config.optimizerKey,
      'binance', config.symbol, config.interval,
    );
    Object.assign(params, best);
    trader.slPct       = params.stopLossPercent;
    trader.tpPct       = params.takeProfitPercent;
    trader.trailingPct = params.trailingPercent;
    saveParamsToEnv(params);
    console.log(
      `[OPTIMIZER] Params refreshed  fast=${params.fastMA} slow=${params.slowMA}` +
      `  sl=${params.stopLossPercent}% tp=${params.takeProfitPercent}%` +
      `  trail=${params.trailingPercent}%`
    );
  } catch (e) {
    console.warn(`[OPTIMIZER] 24h refresh failed (${e.message}) — keeping current params`);
  }
}

// ── Live trading mode ─────────────────────────────────────────────────────────
async function liveTrade(params, exchange) {
  console.log(`[BOT] Live trading ${config.symbol} ${params.interval}  futures=${config.futuresMode}`);

  let candles = await exchange.fetchCandles(config.symbol, params.interval, CANDLE_LIMIT);
  console.log(`[BOT] Loaded ${candles.length} historical candles`);

  const trader = new Trader({
    exchange,
    symbol:            config.symbol,
    tradeCapital:      config.tradeCapital,
    stopLossPercent:   params.stopLossPercent,
    takeProfitPercent: params.takeProfitPercent,
    trailingPercent:   params.trailingPercent,
    futuresMode:       config.futuresMode,
  });

  setInterval(() => refreshParams(params, trader), PARAM_REFRESH_MS);
  console.log(`[OPTIMIZER] Param auto-refresh scheduled every 24h`);

  let lastSignalIdx = -1;

  exchange.subscribeKlines(config.symbol, params.interval, async (candle) => {
    // Check TP/SL on every price tick
    if (trader.inPosition()) {
      await trader.checkStops(candle);
    }

    if (!candle.closed) return;

    // Update rolling candle buffer
    const last = candles[candles.length - 1];
    if (last && last.time === candle.time) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
      if (candles.length > CANDLE_LIMIT) candles = candles.slice(-CANDLE_LIMIT);
    }

    const signal = getLatestSignal(candles, params, lastSignalIdx);
    if (!signal) return;

    lastSignalIdx = signal.candleIdx;
    console.log(
      `[SIGNAL] ${signal.type.toUpperCase().padEnd(4)} @ ${signal.price}` +
      `  RSI=${signal.rsiVal.toFixed(1)}  ${new Date(signal.time * 1000).toISOString().slice(0, 16)}`
    );

    if (signal.type === 'buy') {
      if (!trader.inPosition()) await trader.enter('long');
    } else if (signal.type === 'sell') {
      if (trader.inPosition()) await trader.exit('signal');
      if (config.futuresMode)  await trader.enter('short');
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const params   = await loadParams();
  const exchange = new BinanceClient({
    apiKey:      config.apiKey,
    apiSecret:   config.apiSecret,
    futuresMode: config.futuresMode,
  });

  if (BACKTEST_MODE) {
    await backtest(params, exchange);
    return;
  }

  if (!config.apiKey || !config.apiSecret) {
    console.error('[BOT] BINANCE_API_KEY and BINANCE_API_SECRET must be set for live trading.');
    console.error('      Run with --backtest to test without credentials.');
    process.exit(1);
  }

  await liveTrade(params, exchange);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
