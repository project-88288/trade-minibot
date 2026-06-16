'use strict';

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const WS     = require('ws');

class BinanceClient {
  constructor({ apiKey, apiSecret, futuresMode }) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.futures   = futuresMode;
    this.restBase  = futuresMode ? 'https://fapi.binance.com' : 'https://api.binance.com';
    this.wsBase    = futuresMode ? 'wss://fstream.binance.com' : 'wss://stream.binance.com:9443';
    this._filterCache = {};
  }

  _sign(params) {
    const qs  = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  _request(method, path, params = {}, signed = false) {
    return new Promise((resolve, reject) => {
      const qs  = signed ? this._sign(params) : new URLSearchParams(params).toString();
      const url = (method === 'GET' || method === 'DELETE')
        ? `${this.restBase}${path}${qs ? '?' + qs : ''}`
        : `${this.restBase}${path}`;
      const body = (method !== 'GET' && method !== 'DELETE') ? qs : undefined;

      const opts = {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey },
      };
      if (body) opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const req = https.request(url, opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code && json.code < 0) return reject(new Error(`Binance ${json.code}: ${json.msg}`));
            resolve(json);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // Returns candles as { time(unix sec), open, high, low, close, volume }
  // `startTime` (ms since epoch) limits results to candles opening at or
  // after that point — used to fetch only the gap after local history.
  async fetchCandles(symbol, interval, limit = 500, startTime) {
    const path = this.futures ? '/fapi/v1/klines' : '/api/v3/klines';
    // Binance rejects limits above the endpoint max (futures 1500, spot 1000)
    limit = Math.min(limit, this.futures ? 1500 : 1000);
    const params = { symbol, interval, limit };
    if (startTime) params.startTime = startTime;
    const raw  = await this._request('GET', path, params);
    return raw.map(k => ({
      time:   Math.floor(k[0] / 1000),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  // Returns available USDT balance
  async getBalance() {
    if (this.futures) {
      const info = await this._request('GET', '/fapi/v2/account', {}, true);
      const a = (info.assets || []).find(a => a.asset === 'USDT');
      return a ? parseFloat(a.availableBalance) : 0;
    }
    const info = await this._request('GET', '/api/v3/account', {}, true);
    const b = (info.balances || []).find(b => b.asset === 'USDT');
    return b ? parseFloat(b.free) : 0;
  }

  // Returns the open position for `symbol`, or null if flat (futures only).
  async getPosition(symbol) {
    if (!this.futures) return null;
    const positions = await this._request('GET', '/fapi/v2/positionRisk', { symbol, recvWindow: 10000 }, true);
    const p = positions.find(p => p.symbol === symbol);
    const amt = p ? parseFloat(p.positionAmt) : 0;
    if (!amt) return null;
    return {
      side:       amt > 0 ? 'long' : 'short',
      qty:        Math.abs(amt),
      entryPrice: parseFloat(p.entryPrice),
    };
  }

  // Enter a position — spends quoteCapital USDT at market price.
  // Returns { avgPrice, executedQty }
  async enterMarket(symbol, side, quoteCapital) {
    const params = { symbol, side: side.toUpperCase(), type: 'MARKET' };
    if (this.futures) {
      // Futures MARKET orders reject quoteOrderQty (-1102) — convert to a
      // base-asset quantity using the symbol's LOT_SIZE stepSize.
      const { stepSize } = await this._getFilters(symbol);
      const ticker = await this._request('GET', '/fapi/v1/ticker/price', { symbol });
      const price  = parseFloat(ticker.price);
      params.quantity     = _roundDownToStep(quoteCapital / price, stepSize);
      params.positionSide = 'BOTH';
    } else {
      params.quoteOrderQty = quoteCapital;
    }
    const order = await this._request('POST',
      this.futures ? '/fapi/v1/order' : '/api/v3/order', params, true);

    let avgPrice    = _avgFillPrice(order);
    let executedQty = parseFloat(order.executedQty);
    // Futures MARKET orders sometimes return avgPrice "0"/executedQty "0" in
    // the immediate response before the fill is reflected — poll briefly.
    if (this.futures && (!avgPrice || !executedQty)) {
      for (let attempt = 0; attempt < 5 && (!avgPrice || !executedQty); attempt++) {
        await new Promise(r => setTimeout(r, 300));
        const status = await this._request('GET', '/fapi/v1/order',
          { symbol, orderId: order.orderId, recvWindow: 10000 }, true);
        avgPrice    = _avgFillPrice(status);
        executedQty = parseFloat(status.executedQty);
      }
    }
    return { avgPrice, executedQty };
  }

  // Exit a position — sells exact baseQty at market price.
  // Returns { avgPrice }
  async exitMarket(symbol, side, baseQty) {
    const params = { symbol, side: side.toUpperCase(), type: 'MARKET', quantity: baseQty };
    if (this.futures) { params.positionSide = 'BOTH'; params.reduceOnly = 'true'; }
    const order = await this._request('POST',
      this.futures ? '/fapi/v1/order' : '/api/v3/order', params, true);

    let avgPrice = _avgFillPrice(order);
    // Futures MARKET orders sometimes return avgPrice "0" in the immediate
    // response before the fill is reflected — poll briefly.
    if (this.futures && !avgPrice) {
      for (let attempt = 0; attempt < 5 && !avgPrice; attempt++) {
        await new Promise(r => setTimeout(r, 300));
        const status = await this._request('GET', '/fapi/v1/order',
          { symbol, orderId: order.orderId, recvWindow: 10000 }, true);
        avgPrice = _avgFillPrice(status);
      }
    }
    return { avgPrice };
  }

  // Returns { tickSize } for the symbol's PRICE_FILTER, cached.
  async _getTickSize(symbol) {
    const { tickSize } = await this._getFilters(symbol);
    return { tickSize };
  }

  // Formats a price to the correct number of decimal places for this symbol.
  async formatPrice(symbol, price) {
    const { tickSize } = await this._getFilters(symbol);
    const decimals = (tickSize.toString().split('.')[1] || '').length;
    return price.toFixed(decimals);
  }

  // Returns { tickSize, stepSize } for the symbol's PRICE_FILTER/LOT_SIZE, cached.
  async _getFilters(symbol) {
    if (this._filterCache[symbol]) return this._filterCache[symbol];
    const path = this.futures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const info = await this._request('GET', path, this.futures ? {} : { symbol });
    const symInfo = info.symbols.find(s => s.symbol === symbol);
    const tickSize = parseFloat(symInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize);
    const stepSize = parseFloat(symInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
    this._filterCache[symbol] = { tickSize, stepSize };
    return this._filterCache[symbol];
  }

  // Places exchange-native TAKE_PROFIT_MARKET / STOP_MARKET conditional
  // orders that close the whole position when triggered (futures only).
  // Binance migrated these order types to the Algo Order API — submitting
  // them to /fapi/v1/order now fails with -4120.
  async placeFuturesStopOrders(symbol, { side, takeProfitPrice, stopLossPrice }) {
    if (!this.futures) return;
    const { tickSize } = await this._getTickSize(symbol);
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    const orders = [];
    if (takeProfitPrice) {
      orders.push(this._request('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET',
        triggerPrice: _roundToTick(takeProfitPrice, tickSize),
        closePosition: 'true', workingType: 'MARK_PRICE', recvWindow: 10000,
      }, true));
    }
    if (stopLossPrice) {
      orders.push(this._request('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol, side: closeSide, type: 'STOP_MARKET',
        triggerPrice: _roundToTick(stopLossPrice, tickSize),
        closePosition: 'true', workingType: 'MARK_PRICE', recvWindow: 10000,
      }, true));
    }
    await Promise.all(orders);
  }

  // Places a spot OCO (take-profit limit-maker + stop-loss-limit) order
  // covering `quantity` base units. Returns the OCO's orderListId.
  async placeOco(symbol, quantity, takeProfitPrice, stopLossPrice) {
    if (this.futures) return null;
    const { tickSize } = await this._getTickSize(symbol);
    const tp = _roundToTick(takeProfitPrice, tickSize);
    const sl = _roundToTick(stopLossPrice, tickSize);
    const slLimit = _roundToTick(sl * 0.999, tickSize);
    const order = await this._request('POST', '/api/v3/order/oco', {
      symbol, side: 'SELL', quantity,
      price: tp,
      stopPrice: sl,
      stopLimitPrice: slLimit,
      stopLimitTimeInForce: 'GTC',
    }, true);
    return order.orderListId;
  }

  // Cancels all open orders for a symbol (futures stop orders or spot OCO),
  // including any resting Algo (conditional TP/SL) orders.
  async cancelAllOrders(symbol) {
    const path = this.futures ? '/fapi/v1/allOpenOrders' : '/api/v3/openOrders';
    await this._request('DELETE', path, { symbol, recvWindow: 10000 }, true);
    if (this.futures) {
      const open = await this._request('GET', '/fapi/v1/openAlgoOrders', { symbol, recvWindow: 10000 }, true);
      await Promise.all((open.algoOrders || open || []).map(o =>
        this._request('DELETE', '/fapi/v1/algoOrder', { algoId: o.algoId, recvWindow: 10000 }, true)));
    }
  }

  // Subscribes to kline stream. `onCandle` receives each update including
  // in-progress candles; `candle.closed === true` marks the final update.
  subscribeKlines(symbol, interval, onCandle) {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const url    = `${this.wsBase}/ws/${stream}`;

    const connect = () => {
      const ws = new WS(url);
      ws.on('open',    ()    => console.log(`[WS] ${stream}`));
      ws.on('message', data => {
        const k = JSON.parse(data.toString()).k;
        onCandle({
          time:   Math.floor(k.t / 1000),
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x,
        });
      });
      ws.on('error', e  => console.error('[WS] error:', e.message));
      ws.on('close', () => {
        console.log('[WS] disconnected — reconnecting in 5s');
        setTimeout(connect, 5000);
      });
    };

    connect();
  }
}

// Rounds `value` to the nearest multiple of `tick`, formatted to the same
// number of decimals as `tick` (Binance rejects prices with extra precision).
function _roundToTick(value, tick) {
  const decimals = (tick.toString().split('.')[1] || '').length;
  const rounded  = Math.round(value / tick) * tick;
  return rounded.toFixed(decimals);
}

// Rounds `value` down to a multiple of `step` (Binance LOT_SIZE), formatted
// to the same number of decimals as `step`.
function _roundDownToStep(value, step) {
  const decimals = (step.toString().split('.')[1] || '').length;
  const rounded  = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}

function _avgFillPrice(order) {
  if (order.avgPrice) return parseFloat(order.avgPrice);
  if (order.fills?.length) {
    const qty   = parseFloat(order.executedQty);
    const total = order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0);
    return qty > 0 ? total / qty : 0;
  }
  return parseFloat(order.price || 0);
}

module.exports = { BinanceClient };
