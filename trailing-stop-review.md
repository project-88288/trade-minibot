# Trailing Stop Policy Review

## How it works

The trailing stop is a **"breakeven-first, then trail"** design:

1. Once in a position, `trailBest` tracks the most favorable price seen (candle high for longs, candle low for shorts), but **only once price has crossed entry**.
2. TSL = `trailBest × (1 − trailingPct/100)` for longs.
3. TSL only **replaces** the fixed SL when it has cleared entry price: `if (tsl > entryPrice)`. Until that threshold is crossed, the fixed SL is still active.
4. Same logic runs identically in `trader.js` (`checkStops`) and `backtest.js` (`runSeries`).

---

## Findings

**1. Logic is consistent — no live/backtest divergence in behavior**
Both files update `trailBest` from the candle high/low first, compute TSL second, then immediately check if SL fires on the same candle. Order of operations is identical.

**2. SL is checked before TP within a candle**
Both files check SL first:
```js
if (candle.low  <= effectiveSl) { exit('sl'); return; }
if (candle.high >= tp)          { exit('tp'); return; }
```
On a wide-ranging candle that sweeps both levels, you always get SL. This consistently understates backtest performance vs. reality (where the candle direction determines which was hit first). It is at least symmetric with live behavior.

**3. Edge case: `STOP_LOSS_PERCENT=0` with trailing enabled**
If someone tries to configure trailing-only with `STOP_LOSS_PERCENT=0`:
- `sl = entryPrice × 1.0 = entryPrice`
- TSL only activates when `trailBest × 0.95 > entryPrice`, meaning price must move up by `1/(1−trailingPct)` before the trail takes over — e.g., ~5.3% for a 5% trail
- Until that threshold: `effectiveSl = entryPrice`, so **any candle whose low touches entry fires an immediate breakeven exit**

This may be unintended for trail-only configs. The intended pattern is `slPct ≥ trailingPct` to give the trade breathing room before the trail activates.

**4. Live exit price will differ from backtest for TSL-triggered exits**
In backtest, `exitPrice = effectiveSl` (exact theoretical level). In live, `exit()` sends a market order and fills at whatever price is available. On a sharp reversal, the actual fill can be meaningfully below the TSL level. This is unavoidable without a server-side stop order, but it's worth knowing that backtest TSL P&L is slightly optimistic.

**5. No issue with `trailBest` staleness across candles**
`trailBest` is reset to `null` in both `enter()` and `exit()`. It is correctly scoped to the current open position.

---

## Summary

| | Assessment |
|---|---|
| Live vs backtest consistency | Consistent |
| Trail activation condition | Correct (breakeven-gated) |
| SL vs TP priority same candle | Both pessimistic and consistent |
| `slPct=0` + trailing | Creates tight breakeven stop — likely unintended for trail-only configs |
| Live exit price vs backtest | Market-order slippage makes live worse than backtest for SL exits |

The only actionable concern is **finding 3**: if `TRAILING_PERCENT` is ever set without a meaningful `STOP_LOSS_PERCENT`, the effective behavior is a breakeven stop until the trail kicks in, which can cause premature exits on normal pullbacks early in a move. A guard or note in `.env.example` would prevent misconfiguration.
