# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run live trading bot
node bot.js

# Run backtest against last 500 candles (no API credentials needed)
node bot.js --backtest

# Install as macOS LaunchAgent (auto-restart on crash, manual start)
./setup-service.sh

# Service lifecycle
launchctl start com.ftrade-bot
launchctl stop  com.ftrade-bot
./status.sh

# Logs
tail -f ~/Library/Logs/ftrade-bot/out.log
tail -f ~/Library/Logs/ftrade-bot/err.log
```

## Architecture

`ftrade-bot` is a Binance trading bot that pairs with a companion `ftrade-optimizer-bot` service. At startup it fetches the optimizer's best-ranked parameter set for the configured symbol/interval; if the optimizer is unreachable it falls back to `.env` values. Every 24 hours the live bot re-fetches and hot-applies new params without restarting.

**Startup flow** (`bot.js`):
1. `loadParams()` — calls `optimizerClient.fetchBestParams()` → merges result into `config` → writes back to `.env` via `paramStore.saveParamsToEnv()` as a fallback backup
2. `BinanceClient` is constructed (spot or futures depending on `FUTURES_MODE`)
3. `liveTrade()` — loads 500 historical candles, creates a `Trader`, subscribes to the WebSocket kline stream, and processes every candle tick

**Signal logic** (`src/strategy.js`):
- EMA crossover (fast/slow) confirmed by RSI threshold — buy when fast crosses above slow and RSI is below threshold; sell when fast crosses below slow and RSI is above `100 - threshold`
- The EMA and RSI implementations deliberately replicate the `technicalindicators` npm library so live and backtest signals are identical to optimizer output. Do not change the math here without also updating the optimizer.

**Position management** (`src/trader.js` — `Trader` class):
- Single open position at a time; supports `long` and `short` (futures only)
- Checks TP/SL on every candle tick (including in-progress candles); trailing stop activates once price moves in the favorable direction beyond entry
- `checkStops()` logic must stay in sync with `backtest.js` `runSeries()` so live behavior matches backtest results

**Backtest** (`src/backtest.js`):
- Runs the same signal computation and per-candle TP/SL simulation as the optimizer
- Invoked via `--backtest` flag; no test framework — this is how correctness is verified

**Key invariant:** `strategy.js`, `backtest.js`, and `trader.js` all implement the same signal/exit logic. Any change to one must be reflected in the others, and cross-checked against the optimizer's `simulateTrades` function.

## Configuration

All settings live in `.env` (see `.env.example`). The bot overwrites the strategy-param keys in `.env` after each successful optimizer fetch — this is intentional so params survive a restart when the optimizer is temporarily down. `OPTIMIZER_KEY` is required to contact the optimizer; if unset the bot runs on raw `.env` params.
