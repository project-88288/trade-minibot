'use strict';

const https = require('https');
const http  = require('http');

// Mirrors the optimizer's peer-to-peer candle snapshot exchange (see
// /candles/manifest and /candles/file in ftrade-optimizer-bot's server.js):
// each saved snapshot is named `${exchange}_${symbol}_${interval}_${ISOstamp}.json`
// and holds a plain {time, open, high, low, close, volume}[] array. The bot
// acts as another peer — pulling the newest matching snapshot to seed its
// candle buffer with the same data the optimizer last ran against.
function safeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getJson(url, optimizerKey) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url.toString(), { headers: { 'X-Optimizer-Key': optimizerKey } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Fetches the newest candle snapshot the optimizer has for this
// exchange/symbol/interval combo, or null if it has none.
async function fetchCandlesFromOptimizer(optimizerUrl, optimizerKey, exchange, symbol, interval) {
  const manifestUrl = new URL('/candles/manifest', optimizerUrl);
  const { files } = await getJson(manifestUrl, optimizerKey);

  const prefix   = `${safeKey(exchange)}_${safeKey(symbol)}_${safeKey(interval)}_`;
  const matching = (files || []).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (!matching.length) return null;

  // Filenames embed an ISO timestamp (colons → dashes), so sorting
  // lexicographically also sorts by recency.
  matching.sort();
  const latest = matching[matching.length - 1];

  const fileUrl = new URL(`/candles/file?${new URLSearchParams({ name: latest })}`, optimizerUrl);
  const candles = await getJson(fileUrl, optimizerKey);
  if (!Array.isArray(candles) || !candles.length) return null;

  return candles;
}

module.exports = { fetchCandlesFromOptimizer };
