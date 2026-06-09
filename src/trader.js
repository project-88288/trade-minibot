'use strict';

// Manages a single open position: entry, TP/SL monitoring, and exit.
// Mirrors the backtest's trade simulation so live behavior matches test results.
class Trader {
  constructor({ exchange, symbol, tradeCapital, stopLossPercent, takeProfitPercent,
                trailingPercent, futuresMode }) {
    this.exchange     = exchange;
    this.symbol       = symbol;
    this.capital      = tradeCapital;
    this.slPct        = stopLossPercent;
    this.tpPct        = takeProfitPercent;
    this.trailingPct  = trailingPercent;
    this.futures      = futuresMode;
    this.position     = null; // { side:'long'|'short', entryPrice, qty }
    this.trailBest    = null;
    this.stats        = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
  }

  inPosition() { return this.position !== null; }

  async enter(side) {
    if (this.position) return;
    const orderSide = side === 'long' ? 'BUY' : 'SELL';
    try {
      const { avgPrice, executedQty } = await this.exchange.enterMarket(this.symbol, orderSide, this.capital);
      this.position  = { side, entryPrice: avgPrice, qty: executedQty };
      this.trailBest = null;
      console.log(`[TRADE] ENTER ${side.toUpperCase()} @ ${avgPrice}  qty=${executedQty}`);
    } catch (e) {
      console.error(`[TRADE] enter failed: ${e.message}`);
    }
  }

  async exit(reason) {
    if (!this.position) return;
    const { side, entryPrice, qty } = this.position;
    const exitSide = side === 'long' ? 'SELL' : 'BUY';
    try {
      const { avgPrice } = await this.exchange.exitMarket(this.symbol, exitSide, qty);
      const pnl = side === 'long'
        ? (avgPrice - entryPrice) / entryPrice * 100
        : (entryPrice - avgPrice) / entryPrice * 100;
      if (pnl >= 0) this.stats.wins++; else this.stats.losses++;
      this.stats.trades++;
      this.stats.totalPnl = Math.round((this.stats.totalPnl + pnl) * 100) / 100;
      console.log(
        `[TRADE] EXIT ${side.toUpperCase()} @ ${avgPrice}` +
        `  pnl=${pnl.toFixed(2)}%  reason=${reason}` +
        `  total=${this.stats.totalPnl}%  (${this.stats.wins}W/${this.stats.losses}L)`
      );
    } catch (e) {
      console.error(`[TRADE] exit failed: ${e.message}`);
    }
    this.position  = null;
    this.trailBest = null;
  }

  // Called on every price update (closed or in-progress candle) to trigger
  // TP/SL. Matches the backtest's per-candle high/low check.
  async checkStops(candle) {
    if (!this.position) return;
    const { side, entryPrice } = this.position;
    const isLong = side === 'long';

    const tp = entryPrice * (isLong ? 1 + this.tpPct / 100 : 1 - this.tpPct / 100);
    const sl = entryPrice * (isLong ? 1 - this.slPct / 100 : 1 + this.slPct / 100);

    if (this.trailingPct > 0) {
      if (isLong  && candle.high > entryPrice) this.trailBest = this.trailBest === null ? candle.high : Math.max(this.trailBest, candle.high);
      if (!isLong && candle.low  < entryPrice) this.trailBest = this.trailBest === null ? candle.low  : Math.min(this.trailBest, candle.low);
    }

    let effectiveSl = sl;
    if (this.trailingPct > 0 && this.trailBest !== null) {
      const tsl = isLong
        ? this.trailBest * (1 - this.trailingPct / 100)
        : this.trailBest * (1 + this.trailingPct / 100);
      if (isLong ? tsl > entryPrice : tsl < entryPrice) effectiveSl = tsl;
    }

    if (isLong) {
      if (candle.low  <= effectiveSl) { await this.exit('sl'); return; }
      if (candle.high >= tp)          { await this.exit('tp'); return; }
    } else {
      if (candle.high >= effectiveSl) { await this.exit('sl'); return; }
      if (candle.low  <= tp)          { await this.exit('tp'); return; }
    }
  }
}

module.exports = { Trader };
