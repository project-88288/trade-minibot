'use strict';

const https = require('https');
const http  = require('http');

// Fetches the best saved optimization result for this symbol/interval from
// the ftrade-optimizer-bot service. Returns the top-ranked param set,
// or null if the service is unreachable or has no saved result yet.
async function fetchBestParams(optimizerUrl, optimizerKey, exchange, symbol, interval) {
  const url = new URL(
    `/results?exchange=${encodeURIComponent(exchange)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
    optimizerUrl
  );
  const lib = url.protocol === 'https:' ? https : http;

  const data = await new Promise((resolve, reject) => {
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

  const best = data.result?.top20?.[0];
  if (!best) throw new Error('optimizer returned empty top20');

  return {
    interval:          data.interval,
    fastMA:            best.fast,
    slowMA:            best.slow,
    rsiPeriod:         best.rsiP,
    rsiThreshold:      best.rsiTh,
    stopLossPercent:   best.sl,
    takeProfitPercent: best.tp,
    trailingPercent:   best.trailing,
    tradeFee:          best.fee,
    savedAt:           data.savedAt,
    optimizerPnl:      best.totalPnl,
    optimizerWinRate:  Math.round(best.winRate * 1000) / 10,
  };
}

module.exports = { fetchBestParams };
