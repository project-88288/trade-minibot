'use strict';

const { computeSignals } = require('./strategy');

// Simulates trades over historical candles using the same logic as the
// optimizer's simulateTrades — results should match optimizer output exactly.
function runBacktest(candles, params) {
  const { stopLossPercent: slPct, takeProfitPercent: tpPct,
          trailingPercent: trailingPct, tradeFee: feePct, futuresMode } = params;

  const signals     = computeSignals(candles, params);
  const buySignals  = signals.filter(s => s.type === 'buy');
  const sellSignals = signals.filter(s => s.type === 'sell');
  const buyIdxSet   = new Set(buySignals.map(s => s.candleIdx));
  const sellIdxSet  = new Set(sellSignals.map(s => s.candleIdx));

  const fee2   = 2 * feePct;
  const trades = [];

  function runSeries(entrySigs, isLong) {
    const exitIdxSet = isLong ? sellIdxSet : buyIdxSet;
    let nextEntry = 0;

    for (const sig of entrySigs) {
      if (sig.candleIdx < nextEntry) continue;

      const entry = sig.price;
      const tp    = entry * (isLong ? 1 + tpPct / 100 : 1 - tpPct / 100);
      const sl    = entry * (isLong ? 1 - slPct / 100 : 1 + slPct / 100);
      let trailingBest = null;
      let exitCandle = null, exitPrice = null, exitReason = null;

      for (let j = sig.candleIdx + 1; j < candles.length; j++) {
        const c = candles[j];

        if (trailingPct > 0) {
          if (isLong  && c.high > entry) trailingBest = trailingBest === null ? c.high : Math.max(trailingBest, c.high);
          if (!isLong && c.low  < entry) trailingBest = trailingBest === null ? c.low  : Math.min(trailingBest, c.low);
        }

        let effectiveSl = sl;
        if (trailingPct > 0 && trailingBest !== null) {
          const tsl = isLong
            ? trailingBest * (1 - trailingPct / 100)
            : trailingBest * (1 + trailingPct / 100);
          if (isLong ? tsl > entry : tsl < entry) effectiveSl = tsl;
        }

        if (isLong) {
          if (c.low  <= effectiveSl) { exitCandle = j; exitPrice = effectiveSl; exitReason = 'sl';     break; }
          if (c.high >= tp)          { exitCandle = j; exitPrice = tp;          exitReason = 'tp';     break; }
          if (exitIdxSet.has(j))     { exitCandle = j; exitPrice = c.close;     exitReason = 'signal'; break; }
        } else {
          if (c.high >= effectiveSl) { exitCandle = j; exitPrice = effectiveSl; exitReason = 'sl';     break; }
          if (c.low  <= tp)          { exitCandle = j; exitPrice = tp;          exitReason = 'tp';     break; }
          if (exitIdxSet.has(j))     { exitCandle = j; exitPrice = c.close;     exitReason = 'signal'; break; }
        }
      }

      if (exitCandle === null) { nextEntry = candles.length; continue; }

      const netPnl = isLong
        ? (exitPrice - entry) / entry * 100 - fee2
        : (entry - exitPrice) / entry * 100 - fee2;

      trades.push({
        side:       isLong ? 'long' : 'short',
        entryTime:  new Date(sig.time * 1000).toISOString(),
        entryPrice: entry,
        exitTime:   new Date(candles[exitCandle].time * 1000).toISOString(),
        exitPrice,
        exitReason,
        netPnl: Math.round(netPnl * 100) / 100,
      });

      nextEntry = exitCandle + 1;
    }
  }

  runSeries(buySignals, true);
  if (futuresMode) runSeries(sellSignals, false);

  trades.sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));

  let capital = 100, peak = 100, maxDD = 0, wins = 0, losses = 0, totalPnl = 0;
  for (const t of trades) {
    if (t.netPnl >= 0) wins++; else losses++;
    totalPnl += t.netPnl;
    capital  *= (1 + t.netPnl / 100);
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades,
    summary: {
      total:        trades.length,
      wins,
      losses,
      winRate:      trades.length > 0 ? Math.round(wins / trades.length * 1000) / 10 : 0,
      totalPnl:     Math.round(totalPnl * 100) / 100,
      maxDD:        Math.round(maxDD * 10) / 10,
      finalCapital: Math.round(capital * 100) / 100,
    },
  };
}

module.exports = { runBacktest };
