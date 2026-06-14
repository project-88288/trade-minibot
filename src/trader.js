'use strict';

// Manages a single open position: entry, TP/SL monitoring, and exit.
// Mirrors the backtest's trade simulation so live behavior matches test results.
class Trader {
  constructor({ exchange, symbol, tradeCapital, tradePercent, tradeFee, stopLossPercent, takeProfitPercent,
                trailingPercent, futuresMode }) {
    this.exchange     = exchange;
    this.symbol       = symbol;
    this.capital      = tradeCapital;
    this.tradePercent = tradePercent || 0;
    this.feePct       = tradeFee || 0;
    this.slPct        = stopLossPercent;
    this.tpPct        = takeProfitPercent;
    this.trailingPct  = trailingPercent;
    this.futures      = futuresMode;
    this.position     = null; // { side:'long'|'short', entryPrice, qty }
    this.trailBest    = null;
    this.syncedSl     = null;
    this.syncedTp     = null;
    this.stats        = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
  }

  inPosition() { return this.position !== null; }

  // Returns the USDT notional to spend: a percent of available balance when
  // TRADE_PERCENT > 0, otherwise the fixed TRADE_CAPITAL — same precedence as
  // ftrade-bot-lenovo's orderManager._tradeSize.
  async _tradeSize() {
    if (this.tradePercent > 0) {
      const available = await this.exchange.getBalance();
      return available * this.tradePercent / 100;
    }
    return this.capital;
  }

  // Adopts a position that already exists on the exchange (e.g. the bot
  // restarted, or a previous entry's protective-order sync failed and left
  // the position naked) and (re)syncs its exchange-native TP/SL so it's
  // protected going forward.
  async adoptPosition({ side, entryPrice, qty }) {
    this.position  = { side, entryPrice, qty };
    this.trailBest = null;
    this.syncedSl  = null;
    this.syncedTp  = null;
    console.log(`[TRADE] Adopted existing ${side.toUpperCase()} position @ ${entryPrice}  qty=${qty}`);

    const isLong = side === 'long';
    const tp = entryPrice * (isLong ? 1 + this.tpPct / 100 : 1 - this.tpPct / 100);
    const sl = entryPrice * (isLong ? 1 - this.slPct / 100 : 1 + this.slPct / 100);
    await this._syncProtectiveOrders(tp, sl);
  }

  async enter(side) {
    if (this.position) return;
    const orderSide = side === 'long' ? 'BUY' : 'SELL';
    try {
      const quoteAmt = await this._tradeSize();
      const { avgPrice, executedQty } = await this.exchange.enterMarket(this.symbol, orderSide, quoteAmt);
      this.position  = { side, entryPrice: avgPrice, qty: executedQty };
      this.trailBest = null;
      this.syncedSl  = null;
      this.syncedTp  = null;
      console.log(`[TRADE] ENTER ${side.toUpperCase()} @ ${avgPrice}  qty=${executedQty}`);

      const isLong = side === 'long';
      const tp = avgPrice * (isLong ? 1 + this.tpPct / 100 : 1 - this.tpPct / 100);
      const sl = avgPrice * (isLong ? 1 - this.slPct / 100 : 1 + this.slPct / 100);
      await this._syncProtectiveOrders(tp, sl);
    } catch (e) {
      console.error(`[TRADE] enter failed: ${e.message}`);
    }
  }

  // Places exchange-native TP/SL (futures stop orders or a spot OCO) so the
  // position stays protected even if this bot process goes down. Re-syncing
  // cancels any resting protective orders before placing the new ones —
  // called on entry and again whenever the trailing stop moves.
  async _syncProtectiveOrders(takeProfitPrice, stopLossPrice) {
    if (!this.position) return;
    const hasFutures = this.futures && typeof this.exchange.placeFuturesStopOrders === 'function';
    const hasOco     = !this.futures && typeof this.exchange.placeOco === 'function';
    if (!hasFutures && !hasOco) return;

    try {
      if (typeof this.exchange.cancelAllOrders === 'function') {
        await this.exchange.cancelAllOrders(this.symbol);
      }
      if (hasFutures) {
        await this.exchange.placeFuturesStopOrders(this.symbol, {
          side: this.position.side, takeProfitPrice, stopLossPrice,
        });
      } else {
        await this.exchange.placeOco(this.symbol, this.position.qty, takeProfitPrice, stopLossPrice);
      }
      this.syncedTp = takeProfitPrice;
      this.syncedSl = stopLossPrice;
      console.log(`[TRADE] protective orders synced — TP=${takeProfitPrice}  SL=${stopLossPrice}`);
    } catch (e) {
      console.error(`[TRADE] protective order sync failed: ${e.message}`);
    }
  }

  async exit(reason) {
    if (!this.position) return;
    const { side, entryPrice, qty } = this.position;
    const exitSide = side === 'long' ? 'SELL' : 'BUY';
    try {
      if (typeof this.exchange.cancelAllOrders === 'function') {
        try { await this.exchange.cancelAllOrders(this.symbol); } catch (_) {}
      }
      const { avgPrice } = await this.exchange.exitMarket(this.symbol, exitSide, qty);
      const fee2 = 2 * this.feePct;
      const pnl = side === 'long'
        ? (avgPrice - entryPrice) / entryPrice * 100 - fee2
        : (entryPrice - avgPrice) / entryPrice * 100 - fee2;
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
    this.syncedSl  = null;
    this.syncedTp  = null;
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

    // Keep the exchange-side protective stop in sync as the trailing stop
    // moves, and retry if the initial sync (on entry) never succeeded.
    if ((this.syncedTp === null || this.syncedSl === null) ||
        (effectiveSl !== sl && effectiveSl !== this.syncedSl)) {
      await this._syncProtectiveOrders(tp, effectiveSl);
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
