'use strict';

require('dotenv').config();

const config                  = require('./config');
const { BinanceClient }       = require('./src/exchange');
const { Trader }              = require('./src/trader');
const { getLatestSignal }     = require('./src/strategy');
const { runBacktest }         = require('./src/backtest');
const { fetchBestParams }     = require('./src/optimizerClient');
const { fetchCandlesFromOptimizer } = require('./src/candleSync');
const historyStore            = require('./src/historyStore');
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
      config.exchange, config.symbol, config.interval,
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

// ── Candle loading ────────────────────────────────────────────────────────────
// Fetches every candle from `sinceMs` (inclusive) up to now, paging through
// the exchange's per-request limit.
async function fetchCandlesSince(exchange, interval, sinceMs) {
  const all = [];
  let cursor = sinceMs;
  while (true) {
    const batch = await exchange.fetchCandles(config.symbol, interval, CANDLE_LIMIT, cursor);
    if (!batch.length) break;
    all.push(...batch);
    const nextCursor = batch[batch.length - 1].time * 1000 + 1;
    if (nextCursor <= cursor || batch.length < CANDLE_LIMIT) break;
    cursor = nextCursor;
  }
  return all;
}

// Loads candle history the same way ftrade-bot-lenovo's historyManager does:
// local on-disk history is the base, the gap since its last candle is
// fetched from the exchange, the two are merged/deduped, and the result is
// persisted back to disk so the next start resumes from here. Live trading
// then appends each new closed candle onto this same buffer.
async function loadCandles(exchange, interval) {
  let base = historyStore.load(config.exchange, config.symbol, interval);

  if (!base.length && config.optimizerKey) {
    try {
      const synced = await fetchCandlesFromOptimizer(
        config.optimizerUrl, config.optimizerKey,
        config.exchange, config.symbol, interval,
      );
      if (synced) {
        console.log(`[CANDLES] Seeded ${synced.length} candles from optimizer`);
        base = synced;
      }
    } catch (e) {
      console.warn(`[CANDLES] Optimizer sync failed (${e.message})`);
    }
  }

  const fetched = base.length
    ? await fetchCandlesSince(exchange, interval, base[base.length - 1].time * 1000 + 1)
    : await exchange.fetchCandles(config.symbol, interval, CANDLE_LIMIT);

  const map = new Map();
  for (const c of base)    map.set(c.time, c);
  for (const c of fetched) map.set(c.time, c);
  const merged = [...map.values()].sort((a, b) => a.time - b.time).slice(-CANDLE_LIMIT);

  historyStore.save(config.exchange, config.symbol, interval, merged);
  console.log(`[CANDLES] ${base.length} local + ${fetched.length} fetched → ${merged.length} total`);
  return merged;
}

// ── Backtest mode ─────────────────────────────────────────────────────────────
async function backtest(params, exchange) {
  console.log(`\n[BACKTEST] ${config.symbol} ${params.interval}  last ${CANDLE_LIMIT} candles`);
  console.log(`  fast=${params.fastMA} slow=${params.slowMA} rsiP=${params.rsiPeriod} rsiTh=${params.rsiThreshold}`);
  console.log(`  sl=${params.stopLossPercent}% tp=${params.takeProfitPercent}% trail=${params.trailingPercent}% fee=${params.tradeFee}%\n`);

  const candles = await loadCandles(exchange, params.interval);
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
      config.exchange, config.symbol, config.interval,
    );
    Object.assign(params, best);
    trader.slPct       = params.stopLossPercent;
    trader.tpPct       = params.takeProfitPercent;
    trader.trailingPct = params.trailingPercent;
    trader.feePct      = params.tradeFee;
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

// ── Daily restart ─────────────────────────────────────────────────────────────
// Exits cleanly at local midnight so the LaunchAgent (KeepAlive, restarts on
// any exit) restarts the process — picking up any .env edits (TRADE_PERCENT,
// TRADE_CAPITAL, etc.) and a fresh optimizer fetch via loadParams() on the
// new run. Deferred while a position is open so a restart never strands an
// untracked position.
function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next - now;
}

function scheduleMidnightRestart(trader, restartState) {
  setTimeout(() => {
    if (!trader.inPosition()) {
      console.log('[BOT] Midnight restart — exiting for service restart with fresh config');
      process.exit(0);
    }
    console.log('[BOT] Midnight restart deferred — position open, will exit once it closes');
    restartState.pending = true;
  }, msUntilNextMidnight());
}

// ── Live trading mode ─────────────────────────────────────────────────────────
async function liveTrade(params, exchange) {
  console.log(`[BOT] Live trading ${config.symbol} ${params.interval}  futures=${config.futuresMode}`);

  let candles = await loadCandles(exchange, params.interval);
  console.log(`[BOT] Loaded ${candles.length} historical candles`);

  const trader = new Trader({
    exchange,
    symbol:            config.symbol,
    tradeCapital:      config.tradeCapital,
    tradePercent:      config.tradePercent,
    tradeFee:          params.tradeFee,
    stopLossPercent:   params.stopLossPercent,
    takeProfitPercent: params.takeProfitPercent,
    trailingPercent:   params.trailingPercent,
    futuresMode:       config.futuresMode,
  });

  setInterval(() => refreshParams(params, trader), PARAM_REFRESH_MS);
  console.log(`[OPTIMIZER] Param auto-refresh scheduled every 24h`);

  const restartState = { pending: false };
  scheduleMidnightRestart(trader, restartState);
  console.log(`[BOT] Midnight restart scheduled in ${Math.round(msUntilNextMidnight() / 60000)}m`);

  let lastSignalTime = 0;

  exchange.subscribeKlines(config.symbol, params.interval, async (candle) => {
    // Check TP/SL on every price tick
    if (trader.inPosition()) {
      await trader.checkStops(candle);
    }

    if (restartState.pending && !trader.inPosition()) {
      console.log('[BOT] Midnight restart — position closed, exiting for service restart');
      process.exit(0);
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
    historyStore.save(config.exchange, config.symbol, params.interval, candles);

    const signal = getLatestSignal(candles, params, lastSignalTime);
    if (!signal) return;

    lastSignalTime = signal.time;
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
