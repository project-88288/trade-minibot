'use strict';

// EMA/RSI implementations that exactly match the technicalindicators library
// used by the optimizer, so backtest and live signal results are identical.

function ema(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result; // length = values.length - period + 1
}

function rsi(values, period) {
  const result = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const d    = values[i] - values[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result; // length = values.length - period
}

// Returns all signals over the candle array.
// Each signal: { type: 'buy'|'sell', candleIdx, time, price, rsiVal }
function computeSignals(candles, params) {
  const { fastMA, slowMA, rsiPeriod, rsiThreshold } = params;
  const prices = candles.map(c => c.close);

  const fastVals = ema(prices, fastMA);
  const slowVals = ema(prices, slowMA);
  const rsiVals  = rsi(prices, rsiPeriod);

  const fastOff = prices.length - fastVals.length; // = fastMA - 1
  const slowOff = prices.length - slowVals.length; // = slowMA - 1
  const rsiOff  = prices.length - rsiVals.length;  // = rsiPeriod

  const signals = [];
  const startIdx = Math.max(slowMA, rsiPeriod);

  for (let i = startIdx; i < candles.length; i++) {
    const fi = i - fastOff;
    const si = i - slowOff;
    const ri = i - rsiOff;
    if (fi < 1 || si < 1 || ri < 0) continue;

    const fastNow  = fastVals[fi];
    const fastPrev = fastVals[fi - 1];
    const slowNow  = slowVals[si];
    const slowPrev = slowVals[si - 1];
    const rsiVal   = rsiVals[ri];

    if (fastPrev <= slowPrev && fastNow > slowNow && rsiVal < rsiThreshold) {
      signals.push({ type: 'buy', candleIdx: i, time: candles[i].time, price: candles[i].close, rsiVal });
    } else if (fastPrev >= slowPrev && fastNow < slowNow && rsiVal > (100 - rsiThreshold)) {
      signals.push({ type: 'sell', candleIdx: i, time: candles[i].time, price: candles[i].close, rsiVal });
    }
  }

  return signals;
}

// Returns the signal on the most recent closed candle, or null if none.
// `afterIdx` lets callers skip already-processed signals.
function getLatestSignal(candles, params, afterIdx = -1) {
  const signals = computeSignals(candles, params);
  if (!signals.length) return null;
  const last = signals[signals.length - 1];
  if (last.candleIdx <= afterIdx) return null;
  if (last.candleIdx !== candles.length - 1) return null;
  return last;
}

module.exports = { computeSignals, getLatestSignal, ema, rsi };
