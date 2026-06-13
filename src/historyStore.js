'use strict';

const fs   = require('fs');
const path = require('path');

// Local on-disk candle history, persisted between restarts so the bot can
// resume from where it left off instead of re-fetching its whole window —
// same idea as ftrade-bot-lenovo's historyManager, minus the SQLite/multi-
// timeframe parts this single-pair bot doesn't need.
const DATA_DIR = path.join(__dirname, '..', 'data');

function safeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function fileFor(exchange, symbol, interval) {
  return path.join(DATA_DIR, `candles_${safeKey(exchange)}_${safeKey(symbol)}_${safeKey(interval)}.json`);
}

function load(exchange, symbol, interval) {
  try {
    const candles = JSON.parse(fs.readFileSync(fileFor(exchange, symbol, interval), 'utf8'));
    return Array.isArray(candles) ? candles : [];
  } catch (_) {
    return [];
  }
}

function save(exchange, symbol, interval, candles) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(fileFor(exchange, symbol, interval), JSON.stringify(candles));
}

module.exports = { load, save };
