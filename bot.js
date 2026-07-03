'use strict';

require('dotenv').config();

const config                  = require('./config');
const { BinanceClient }       = require('./src/exchange');
const { KuCoinClient }        = require('./src/kucoinExchange');
const { Trader }              = require('./src/trader');
const { getLatestSignal }     = require('./src/strategy');
const { runBacktest }         = require('./src/backtest');
const { fetchBestParams }     = require('./src/optimizerClient');
const { fetchCandlesFromOptimizer } = require('./src/candleSync');
const historyStore            = require('./src/historyStore');
const { saveParamsToEnv, saveBacktestToEnv } = require('./src/paramStore');

const BACKTEST_MODE     = process.argv.includes('--backtest');
const CANDLE_LIMIT      = 1500;
const PARAM_REFRESH_MS  = 24 * 60 * 60 * 1000; // 24 hours

// Candle buffer size. Starts at CANDLE_LIMIT and grows: loadCandles() widens it
// to the full loaded history (optimizer snapshot + backfill, at least
// MIN_CANDLES) and live trading widens it as each new closed candle is appended,
// so the window keeps growing past MIN_CANDLES — up to MAX_CANDLES, after which
// the oldest candles drop off.
let candleBufferLimit = CANDLE_LIMIT;

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
// Milliseconds per candle for an interval string like '5m', '1h', '1d', '1w'.
function intervalToMs(interval) {
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) throw new Error(`Unsupported interval: ${interval}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return parseInt(m[1], 10) * unit;
}

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

// Fetches candles older than `beforeMs`, paging backward, until at least
// `needed` are collected or the exchange has no more history to give. Both
// exchange clients only fetch forward from a startTime, so each pass asks for
// the CANDLE_LIMIT-wide window ending at the current earliest and keeps the
// candles that fall before it. Returns candles in ascending time order.
async function fetchCandlesBackTo(exchange, interval, beforeMs, needed) {
  const granMs = intervalToMs(interval);
  const collected = [];
  let endMs = beforeMs; // exclusive upper bound for the next pass
  while (collected.length < needed) {
    const startMs = Math.max(0, endMs - CANDLE_LIMIT * granMs);
    const batch = await exchange.fetchCandles(config.symbol, interval, CANDLE_LIMIT, startMs);
    const older = batch.filter(c => c.time * 1000 < endMs);
    if (!older.length) break;                 // nothing before this point
    collected.unshift(...older);
    const newEarliest = older[0].time * 1000;
    if (newEarliest >= endMs) break;          // no progress — history exhausted
    endMs = newEarliest;
  }
  return collected;
}

// Loads candle history the same way ftrade-bot-lenovo's historyManager does:
// local on-disk history is the base, the gap since its last candle is
// fetched from the exchange, the two are merged/deduped, and the result is
// persisted back to disk so the next start resumes from here. Live trading
// then appends each new closed candle onto this same buffer.
async function loadCandles(exchange, interval) {
  let base = historyStore.load(config.exchange, config.symbol, interval);

  // Always pull the optimizer's full history snapshot (the same candles it
  // used to pick the current params) and merge it into the base, so the
  // gate backtest below matches the optimizer's result.
  if (config.optimizerKey) {
    try {
      const synced = await fetchCandlesFromOptimizer(
        config.optimizerUrl, config.optimizerKey,
        config.exchange, config.symbol, interval,
      );
      if (synced && synced.length) {
        console.log(`[CANDLES] Pulled ${synced.length} candles of full history from optimizer`);
        const map = new Map();
        for (const c of base)   map.set(c.time, c);
        for (const c of synced) map.set(c.time, c);
        base = [...map.values()].sort((a, b) => a.time - b.time);
      }
    } catch (e) {
      console.warn(`[CANDLES] Optimizer history sync failed (${e.message})`);
    }
  }

  // Forward fill: fetch the gap from the last known candle up to now (or a
  // fresh CANDLE_LIMIT window when there's no local/optimizer history yet).
  const fetched = base.length
    ? await fetchCandlesSince(exchange, interval, base[base.length - 1].time * 1000 + 1)
    : await exchange.fetchCandles(config.symbol, interval, CANDLE_LIMIT);

  const map = new Map();
  for (const c of base)    map.set(c.time, c);
  for (const c of fetched) map.set(c.time, c);
  let merged = [...map.values()].sort((a, b) => a.time - b.time);

  // Backward fill: if the buffer still holds fewer than MIN_CANDLES, keep
  // fetching older history before the earliest candle until we reach the
  // target (or the exchange runs out of history).
  let backfilled = 0;
  if (merged.length && merged.length < config.minCandles) {
    const older = await fetchCandlesBackTo(
      exchange, interval,
      merged[0].time * 1000,
      config.minCandles - merged.length,
    );
    backfilled = older.length;
    for (const c of older) map.set(c.time, c);
    merged = [...map.values()].sort((a, b) => a.time - b.time);
  }

  // Keep every candle we loaded (optimizer history, the backfill, or at least
  // MIN_CANDLES) — the buffer grows from here, capped at MAX_CANDLES.
  candleBufferLimit = Math.min(
    config.maxCandles,
    Math.max(CANDLE_LIMIT, config.minCandles, merged.length),
  );
  merged = merged.slice(-candleBufferLimit);

  historyStore.save(config.exchange, config.symbol, interval, merged);
  console.log(
    `[CANDLES] ${base.length} local+optimizer + ${fetched.length} forward` +
    ` + ${backfilled} backward → ${merged.length} total (min ${config.minCandles})`
  );
  if (merged.length < config.minCandles) {
    console.warn(
      `[CANDLES] Only ${merged.length}/${config.minCandles} candles available —` +
      ` exchange history for ${config.symbol} ${interval} may not go back far enough`
    );
  }
  return merged;
}

// ── Backtest mode ─────────────────────────────────────────────────────────────
async function backtest(params, exchange) {
  console.log(`\n[BACKTEST] ${config.symbol} ${params.interval}  min ${config.minCandles} candles`);
  console.log(`  fast=${params.fastMA} slow=${params.slowMA} rsiP=${params.rsiPeriod} rsiTh=${params.rsiThreshold}`);
  console.log(`  sl=${params.stopLossPercent}% tp=${params.takeProfitPercent}% trail=${params.trailingPercent}% fee=${params.tradeFee}%\n`);

  const candles = await loadCandles(exchange, params.interval);
  const { trades, summary: s } = runBacktest(candles, params);

  console.log('── Summary ────────────────────────────────────────');
  console.log(`  Candles  : ${s.candleLength}`);
  console.log(`  Trades   : ${s.total} (${s.wins}W / ${s.losses}L)  WinRate: ${s.winRate}%`);
  console.log(`  PnL      : ${s.totalPnl}%  MaxDD: ${s.maxDD}%  Fees: $${s.totalFee}`);
  console.log(`  ROA      : ${s.annualReturn}%/yr`);
  console.log(`  Capital  : $100 → $${s.finalCapital}`);
  console.log('───────────────────────────────────────────────────');
  saveBacktestToEnv(s);

  if (trades.length) {
    console.log('\nTrade log:');
    const fmtPrice = typeof exchange.formatPrice === 'function'
      ? (p) => exchange.formatPrice(config.symbol, p)
      : (p) => Promise.resolve(String(p));
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const pnlStr   = (t.netPnl >= 0 ? '+' : '') + t.netPnl + '%';
      const entryFmt = await fmtPrice(t.entryPrice);
      const exitFmt  = await fmtPrice(t.exitPrice);
      console.log(
        `  ${String(i + 1).padStart(3)}.` +
        ` ${t.side.padEnd(5)}` +
        `  in  ${t.entryTime.slice(0, 16)} @ ${entryFmt}` +
        `  out ${t.exitTime.slice(0, 16)} @ ${exitFmt}` +
        `  ${pnlStr.padStart(8)}  [${t.exitReason}]`
      );
    }
  }
}

// ── Backtest trade gate ────────────────────────────────────────────────────────
// Runs a backtest with the current candles/params and compares the annualized
// return (ROA) against MIN_ALLOW_PERCENT. Saves the full result to .env and is
// used on startup and after every param reload to decide whether the bot is
// allowed to open new trades.
function checkTradeGate(candles, params) {
  const { summary } = runBacktest(candles, params);
  saveBacktestToEnv(summary);
  const allowed = summary.annualReturn >= config.minAllowPercent;
  const detail = `ROA ${summary.annualReturn}%/yr (${summary.candleLength} candles, PnL ${summary.totalPnl}%)`;
  if (allowed) {
    console.log(`[GATE] Backtest ${detail} >= MIN_ALLOW_PERCENT ${config.minAllowPercent}% — trading enabled`);
  } else {
    console.warn(`[GATE] Backtest ${detail} < MIN_ALLOW_PERCENT ${config.minAllowPercent}% — new trades halted until next reload`);
  }
  return allowed;
}

// ── 24-hour param refresh ─────────────────────────────────────────────────────
async function refreshParams(params, trader, candles, tradeGate) {
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
    tradeGate.allowed = checkTradeGate(candles, params);
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

// ── API-key permission validation ─────────────────────────────────────────────
// Startup fail-safe: checks the API key is no more powerful than a trading bot
// needs. The critical one is withdrawals — a key that can withdraw turns a
// leak into a drained account. Warns by default; with STRICT_KEY_CHECK=true it
// refuses to start when withdrawals are enabled.
async function checkKeyPermissions(exchange) {
  if (typeof exchange.getApiPermissions !== 'function') {
    console.log('[KEYCHECK] Permission validation not supported for this exchange — skipping');
    return;
  }

  let perms;
  try {
    perms = await exchange.getApiPermissions();
  } catch (e) {
    console.warn(`[KEYCHECK] Could not read API key permissions (${e.message}) — continuing`);
    return;
  }

  const warnings = [];
  if (perms.enableWithdrawals)
    warnings.push('withdrawals are ENABLED — a leaked key could drain funds; disable withdrawal permission');
  if (!perms.ipRestrict)
    warnings.push("no IP allowlist set — restrict the key to this host's IP");
  if (config.futuresMode && perms.enableFutures === false)
    warnings.push('futures trading is NOT enabled on this key — orders will fail');
  if (!config.futuresMode && perms.enableSpotAndMarginTrading === false)
    warnings.push('spot trading is NOT enabled on this key — orders will fail');

  if (!warnings.length) {
    console.log('[KEYCHECK] API key permissions OK — no withdrawals, IP-restricted');
    return;
  }
  for (const w of warnings) console.warn(`[KEYCHECK] ⚠ ${w}`);
  if (config.strictKeyCheck && perms.enableWithdrawals) {
    console.error('[KEYCHECK] STRICT_KEY_CHECK=true and withdrawals enabled — refusing to start');
    process.exit(1);
  }
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

  // Recover a position that's already open on the exchange — e.g. a previous
  // run entered but its protective-order sync failed, leaving it naked, or
  // the bot restarted while a position was open.
  if (typeof exchange.getPosition === 'function') {
    const existing = await exchange.getPosition(config.symbol);
    if (existing) await trader.adoptPosition(existing);
  }

  const tradeGate = { allowed: checkTradeGate(candles, params) };

  setInterval(() => refreshParams(params, trader, candles, tradeGate), PARAM_REFRESH_MS);
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
      if (candles.length > config.maxCandles) candles = candles.slice(-config.maxCandles);
      candleBufferLimit = candles.length;
    }
    historyStore.save(config.exchange, config.symbol, params.interval, candles);

    const signal = getLatestSignal(candles, params, lastSignalTime);
    if (!signal) return;

    lastSignalTime = signal.time;
    const signalPriceFmt = typeof exchange.formatPrice === 'function'
      ? await exchange.formatPrice(config.symbol, signal.price)
      : signal.price;
    console.log(
      `[SIGNAL] ${signal.type.toUpperCase().padEnd(4)} @ ${signalPriceFmt}` +
      `  RSI=${signal.rsiVal.toFixed(1)}  ${new Date(signal.time * 1000).toISOString().slice(0, 16)}`
    );

    if (signal.type === 'buy') {
      if (!trader.inPosition()) {
        if (tradeGate.allowed) await trader.enter('long');
        else console.log('[GATE] Buy signal ignored — trading halted until next reload/restart');
      }
    } else if (signal.type === 'sell') {
      if (trader.inPosition()) await trader.exit('signal');
      if (config.futuresMode) {
        if (tradeGate.allowed) await trader.enter('short');
        else console.log('[GATE] Short signal ignored — trading halted until next reload/restart');
      }
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const params   = await loadParams();
  const isKuCoin = config.exchange === 'kucoin';
  const exchange = isKuCoin
    ? new KuCoinClient({
        apiKey:         config.kucoinApiKey,
        apiSecret:      config.kucoinApiSecret,
        passphrase:     config.kucoinApiPassphrase,
        symbolOverride: config.kucoinSymbol,
        marginMode:     config.kucoinMarginMode,
        leverage:       config.leverage,
      })
    : new BinanceClient({
        apiKey:      config.apiKey,
        apiSecret:   config.apiSecret,
        futuresMode: config.futuresMode,
      });

  if (BACKTEST_MODE) {
    await backtest(params, exchange);
    return;
  }

  if (isKuCoin) {
    if (!config.kucoinApiKey || !config.kucoinApiSecret || !config.kucoinApiPassphrase) {
      console.error('[BOT] KUCOIN_API_KEY, KUCOIN_API_SECRET and KUCOIN_API_PASSPHRASE must be set for live trading.');
      console.error('      Run with --backtest to test without credentials.');
      process.exit(1);
    }
  } else if (!config.apiKey || !config.apiSecret) {
    console.error('[BOT] BINANCE_API_KEY and BINANCE_API_SECRET must be set for live trading.');
    console.error('      Run with --backtest to test without credentials.');
    process.exit(1);
  }

  await checkKeyPermissions(exchange);
  await liveTrade(params, exchange);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
