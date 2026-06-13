# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run live trading bot
node bot.js

# Run backtest against last 1500 candles (no API credentials needed)
node bot.js --backtest

# Install as macOS LaunchAgent (auto-restart, manual start)
./setup-service-mc.sh

# Service lifecycle — label is derived from folder/optimizer URL (see
# service-label.sh); setup-service-mc.sh prints the exact label
source ./service-label.sh
launchctl start "$SERVICE_LABEL"
launchctl stop  "$SERVICE_LABEL"
./status.sh

# Logs
tail -f ~/Library/Logs/ftrade-bot-<folder-name>/out.log
tail -f ~/Library/Logs/ftrade-bot-<folder-name>/err.log
```

## Architecture

`ftrade-bot` is a Binance/KuCoin trading bot that pairs with a companion `ftrade-optimizer-bot` service. At startup it fetches the optimizer's best-ranked parameter set for the configured symbol/interval; if the optimizer is unreachable it falls back to `.env` values. Every 24 hours the live bot re-fetches and hot-applies new params without restarting. It also exits cleanly at local midnight so the LaunchAgent restarts it with a fully fresh `.env`/optimizer fetch (see **Midnight restart** below).

**Startup flow** (`bot.js`):
1. `loadParams()` — calls `optimizerClient.fetchBestParams()` → merges result into `config` → writes back to `.env` via `paramStore.saveParamsToEnv()` as a fallback backup
2. `BinanceClient` or `KuCoinClient` is constructed depending on `EXCHANGE` (`src/exchange.js` / `src/kucoinExchange.js`). Binance is spot or futures depending on `FUTURES_MODE`; KuCoin support is KuCoin Futures only, so `FUTURES_MODE` is always treated as `true` when `EXCHANGE=kucoin`. KuCoin requires `KUCOIN_API_KEY`/`KUCOIN_API_SECRET`/`KUCOIN_API_PASSPHRASE` and maps the Binance-style `SYMBOL` (e.g. `BTCUSDT`) to its futures symbol (e.g. `XBTUSDTM`) unless `KUCOIN_SYMBOL` overrides it
3. `liveTrade()` — loads 1500 historical candles via `loadCandles()` (Binance spot is clamped to 1000 by the Binance endpoint; KuCoin paginates internally in `fetchCandles()`), creates a `Trader`, subscribes to the WebSocket kline stream, and processes every candle tick

**Midnight restart** (`bot.js`):
- `scheduleMidnightRestart()` sets a timeout for the next local midnight; when it fires, the process exits with code 0 if no position is open, or sets `restartState.pending` if one is — the kline handler then exits as soon as that position closes
- Relies on the LaunchAgent's `KeepAlive: true` (see `setup-service-mc.sh`) to restart the process on any exit, clean or crashed — a clean exit is how the bot re-runs `loadParams()`/`loadCandles()` against the current `.env` (e.g. `TRADE_PERCENT`, `TRADE_CAPITAL`) and the optimizer's latest saved result

**Candle history** (`src/historyStore.js`, `src/candleSync.js`):
- `loadCandles()` in `bot.js` (used for both backtest and live startup) follows ftrade-bot-lenovo's historyManager pattern: local on-disk history (`data/candles_<exchange>_<symbol>_<interval>.json`) is the base, the gap since its last candle is fetched from the exchange via `fetchCandlesSince()`, the two are merged/deduped by time, and the result is persisted back to disk
- On first run (no local history), the optimizer's P2P candle snapshot store is tried first via `fetchCandlesFromOptimizer()` (`/candles/manifest` + `/candles/file`) to seed the base before falling back to a full `exchange.fetchCandles()` REST fetch
- During live trading, every newly closed candle appended to the rolling buffer is persisted via `historyStore.save()`, so the next restart resumes from there with only a small gap to fetch

**Signal logic** (`src/strategy.js`):
- EMA crossover (fast/slow) confirmed by RSI threshold — buy when fast crosses above slow and RSI is below threshold; sell when fast crosses below slow and RSI is above `100 - threshold`
- The EMA and RSI implementations deliberately replicate the `technicalindicators` npm library so live and backtest signals are identical to optimizer output. Do not change the math here without also updating the optimizer.

**Position management** (`src/trader.js` — `Trader` class):
- Single open position at a time; supports `long` and `short` (futures only)
- Checks TP/SL on every candle tick (including in-progress candles); trailing stop activates once price moves in the favorable direction beyond entry
- `checkStops()` logic must stay in sync with `backtest.js` `runSeries()` so live behavior matches backtest results
- Trade sizing (`_tradeSize()`) mirrors ftrade-bot-lenovo's `orderManager`: if `TRADE_PERCENT` > 0, spend that percent of the live exchange balance (`exchange.getBalance()`); otherwise spend the fixed `TRADE_CAPITAL`
- `exit()` subtracts a round-trip fee (`2 * TRADE_FEE`, i.e. `fee2`) from the realized PnL%, matching `backtest.js`'s `fee2 = 2 * feePct` so live PnL and backtest PnL are computed the same way

**Backtest** (`src/backtest.js`):
- Runs the same signal computation and per-candle TP/SL simulation as the optimizer
- Invoked via `--backtest` flag; no test framework — this is how correctness is verified

**Key invariant:** `strategy.js`, `backtest.js`, and `trader.js` all implement the same signal/exit logic. Any change to one must be reflected in the others, and cross-checked against the optimizer's `simulateTrades` function.

## Configuration

All settings live in `.env` (see `.env.example`). The bot overwrites the strategy-param keys in `.env` after each successful optimizer fetch — this is intentional so params survive a restart when the optimizer is temporarily down. `OPTIMIZER_KEY` is required to contact the optimizer; if unset the bot runs on raw `.env` params.

**Backtest trade gate** (`bot.js` — `checkTradeGate()`):
- On startup, and after every param reload (24h optimizer refresh), the bot runs a backtest over the currently loaded candles with the active params (optimizer-supplied or `.env` fallback) and compares the total PnL% to `MIN_ALLOW_PERCENT`
- If the backtest result is below `MIN_ALLOW_PERCENT`, new entries are skipped (logged as `[GATE] ... ignored`) but the bot keeps running — it still monitors and exits any open position normally. The gate is only re-evaluated on the next reload/restart
