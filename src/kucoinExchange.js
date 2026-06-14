'use strict';

const https  = require('https');
const crypto = require('crypto');
const WS     = require('ws');

// Binance-style interval string → KuCoin Futures granularity in minutes.
// KuCoin Futures doesn't support 3m or 1M.
const INTERVAL_MIN = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '8h': 480, '12h': 720,
  '1d': 1440, '1w': 10080,
};

// Rounds `value` to the nearest multiple of `tick`, formatted to the same
// number of decimals as `tick` (KuCoin rejects prices with extra precision).
function _roundToTick(value, tick) {
  const decimals = (tick.toString().split('.')[1] || '').length;
  const rounded  = Math.round(value / tick) * tick;
  return rounded.toFixed(decimals);
}

// Map a Binance-style symbol (e.g. BTCUSDT) to a KuCoin Futures perpetual
// symbol (e.g. XBTUSDTM). BTC → XBT, all USDT-margined perps get an M suffix.
function toKuCoinSymbol(binanceSymbol) {
  const base   = binanceSymbol.replace(/USDT$/, '');
  const kcBase = base === 'BTC' ? 'XBT' : base;
  return `${kcBase}USDTM`;
}

class KuCoinClient {
  constructor({ apiKey, apiSecret, passphrase, symbolOverride, marginMode, leverage }) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase;
    this.marginMode = marginMode || 'CROSS';
    this.leverage   = leverage || 1;
    this.restBase   = 'https://api-futures.kucoin.com';
    this.wsTokenPath = '/api/v1/bullet-public';

    this._overrideSymbol = symbolOverride || null;
    this._contractCache  = {};
  }

  _ks(symbol) {
    return this._overrideSymbol || toKuCoinSymbol(symbol);
  }

  _sign(ts, method, path, body) {
    const str = `${ts}${method}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(str).digest('base64');
  }

  _signPassphrase() {
    return crypto.createHmac('sha256', this.apiSecret).update(this.passphrase).digest('base64');
  }

  _request(method, path, params = {}, signed = false) {
    return new Promise((resolve, reject) => {
      const qs      = new URLSearchParams(params).toString();
      const isGet   = method === 'GET' || method === 'DELETE';
      const reqPath = isGet && qs ? `${path}?${qs}` : path;
      const bodyStr = !isGet && Object.keys(params).length ? JSON.stringify(params) : '';
      const ts      = Date.now().toString();

      const headers = { 'Content-Type': 'application/json' };
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      if (signed) {
        headers['KC-API-KEY']         = this.apiKey;
        headers['KC-API-SIGN']        = this._sign(ts, method, reqPath, bodyStr);
        headers['KC-API-TIMESTAMP']   = ts;
        headers['KC-API-PASSPHRASE']  = this._signPassphrase();
        headers['KC-API-KEY-VERSION'] = '2';
      }

      const req = https.request(`${this.restBase}${reqPath}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code !== '200000') return reject(new Error(`KuCoin ${json.code}: ${json.msg || data}`));
            resolve(json.data);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async _contractInfo(ks) {
    if (this._contractCache[ks]) return this._contractCache[ks];
    const data = await this._request('GET', `/api/v1/contracts/${ks}`);
    const info = {
      multiplier: parseFloat(data.multiplier),
      tickSize:   parseFloat(data.tickSize),
    };
    this._contractCache[ks] = info;
    return info;
  }

  // Returns candles as { time(unix sec), open, high, low, close, volume }.
  // `startTime` (ms since epoch) limits results to candles opening at or
  // after that point — used to fetch only the gap after local history.
  // KuCoin's kline/query is paged internally (200 candles/request) so this
  // returns up to `limit` candles in one call, like the Binance client.
  async fetchCandles(symbol, interval, limit = 500, startTime) {
    const ks          = this._ks(symbol);
    const granularity = INTERVAL_MIN[interval];
    if (!granularity) throw new Error(`Interval ${interval} not supported on KuCoin Futures`);

    const granMs = granularity * 60 * 1000;
    const now    = Date.now();
    let from     = startTime || (now - limit * granMs);
    const out    = [];

    while (out.length < limit) {
      const to   = Math.min(from + 200 * granMs, now);
      const data = await this._request('GET', '/api/v1/kline/query', { symbol: ks, granularity, from, to });
      if (!Array.isArray(data) || !data.length) break;
      for (const k of data) {
        out.push({
          time:   Math.floor(k[0] / 1000),
          open:   parseFloat(k[1]),
          high:   parseFloat(k[2]),
          low:    parseFloat(k[3]),
          close:  parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
      if (to >= now) break;
      from = data[data.length - 1][0] + granMs;
    }
    return out.slice(0, limit);
  }

  // Returns available USDT balance
  async getBalance() {
    const data = await this._request('GET', '/api/v1/account-overview', { currency: 'USDT' }, true);
    return parseFloat(data.availableBalance || 0);
  }

  // Returns the open position for `symbol`, or null if flat.
  // `qty` is in base-asset units (contracts * multiplier); `side` is
  // 'long' or 'short' based on the sign of currentQty.
  async getPosition(symbol) {
    const ks   = this._ks(symbol);
    const info = await this._contractInfo(ks);
    const data = await this._request('GET', '/api/v1/position', { symbol: ks }, true);
    const currentQty = parseFloat(data?.currentQty || 0);
    if (!currentQty) return null;
    return {
      side:       currentQty > 0 ? 'long' : 'short',
      qty:        Math.abs(currentQty) * info.multiplier,
      entryPrice: parseFloat(data.avgEntryPrice || 0),
    };
  }

  // Enter a position — spends quoteCapital USDT at market price.
  // Returns { avgPrice, executedQty } (executedQty in base-asset units)
  async enterMarket(symbol, side, quoteCapital) {
    const ks   = this._ks(symbol);
    const info = await this._contractInfo(ks);
    const ticker = await this._request('GET', '/api/v1/ticker', { symbol: ks });
    const price  = parseFloat(ticker.price);

    const contracts = Math.max(1, Math.round((quoteCapital / price) / info.multiplier));
    return this._placeOrder(ks, side, contracts, info, price, false);
  }

  // Exit a position — sells exact baseQty at market price.
  // Returns { avgPrice }
  async exitMarket(symbol, side, baseQty) {
    const ks   = this._ks(symbol);
    const info = await this._contractInfo(ks);
    const ticker = await this._request('GET', '/api/v1/ticker', { symbol: ks });
    const price  = parseFloat(ticker.price);

    const contracts = Math.max(1, Math.round(baseQty / info.multiplier));
    const { avgPrice } = await this._placeOrder(ks, side, contracts, info, price, true);
    return { avgPrice };
  }

  async _placeOrder(ks, side, contracts, info, fallbackPrice, reduceOnly) {
    const body = {
      clientOid:  `ftrade_${Date.now()}`,
      symbol:     ks,
      side:       side.toLowerCase(),
      type:       'market',
      leverage:   String(this.leverage),
      size:       contracts,
      marginMode: this.marginMode,
    };
    if (reduceOnly) body.reduceOnly = true;

    const resp = await this._request('POST', '/api/v1/orders', body, true);

    let avgPrice    = fallbackPrice;
    let filledConts = contracts;
    // The fill often isn't reflected yet on the immediate status fetch, so
    // poll briefly until filledValue is populated before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 300));
      try {
        const order = await this._request('GET', `/api/v1/orders/${resp.orderId}`, {}, true);
        filledConts = parseFloat(order.filledSize) || contracts;
        const filledValue = parseFloat(order.filledValue) || 0;
        if (filledValue > 0 && filledConts > 0) {
          avgPrice = filledValue / (filledConts * info.multiplier);
          break;
        }
      } catch (_) {}
    }

    return { avgPrice, executedQty: filledConts * info.multiplier };
  }

  // Places exchange-native stop-market orders (mark-price triggered) that
  // close the whole position when triggered.
  async placeFuturesStopOrders(symbol, { side, takeProfitPrice, stopLossPrice }) {
    const ks   = this._ks(symbol);
    const info = await this._contractInfo(ks);
    const closeSide = side === 'long' ? 'sell' : 'buy';
    const orders = [];

    if (takeProfitPrice) {
      orders.push(this._request('POST', '/api/v1/orders', {
        clientOid:     `ftrade_tp_${Date.now()}`,
        symbol:        ks,
        side:          closeSide,
        type:          'market',
        stop:          side === 'long' ? 'up' : 'down',
        stopPriceType: 'MP',
        stopPrice:     _roundToTick(takeProfitPrice, info.tickSize),
        reduceOnly:    true,
        closeOrder:    true,
        marginMode:    this.marginMode,
      }, true));
    }
    if (stopLossPrice) {
      orders.push(this._request('POST', '/api/v1/orders', {
        clientOid:     `ftrade_sl_${Date.now()}`,
        symbol:        ks,
        side:          closeSide,
        type:          'market',
        stop:          side === 'long' ? 'down' : 'up',
        stopPriceType: 'MP',
        stopPrice:     _roundToTick(stopLossPrice, info.tickSize),
        reduceOnly:    true,
        closeOrder:    true,
        marginMode:    this.marginMode,
      }, true));
    }
    await Promise.all(orders);
  }

  // Cancels resting stop orders and any open orders for the symbol.
  async cancelAllOrders(symbol) {
    const ks = this._ks(symbol);
    await Promise.allSettled([
      this._request('DELETE', '/api/v1/stopOrders', { symbol: ks }, true),
      this._request('DELETE', '/api/v1/orders', { symbol: ks }, true),
    ]);
  }

  // Subscribes to kline stream. `onCandle` receives each update including
  // in-progress candles; `candle.closed === true` marks the final update.
  subscribeKlines(symbol, interval, onCandle) {
    const ks          = this._ks(symbol);
    const granularity = INTERVAL_MIN[interval];
    if (!granularity) throw new Error(`Interval ${interval} not supported on KuCoin Futures`);

    let ws = null;
    let pingTimer = null;
    let lastOpenMs = null;
    let lastCandle = null;

    const connect = async () => {
      let tokenData;
      try {
        tokenData = await this._request('POST', this.wsTokenPath);
      } catch (e) {
        console.error('[WS] token error:', e.message);
        setTimeout(connect, 5000);
        return;
      }

      const server = tokenData.instanceServers[0];
      const url     = `${server.endpoint}?token=${tokenData.token}&connectId=ftrade${Date.now()}`;
      ws = new WS(url);

      ws.on('open', () => {
        console.log(`[WS] ${ks}_${granularity}`);
        pingTimer = setInterval(() => {
          if (ws.readyState === WS.OPEN) {
            ws.send(JSON.stringify({ id: String(Date.now()), type: 'ping' }));
          }
        }, server.pingInterval || 18000);
        ws.send(JSON.stringify({
          id:       `sub_${Date.now()}`,
          type:     'subscribe',
          topic:    `/contractMarket/candle:${ks}_${granularity}`,
          response: true,
        }));
      });

      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type !== 'message' || msg.subject !== 'candle.stick') return;

        const d = msg.data;
        if (!d) return;

        const openTimeMs = d.time;
        const candle = {
          time:   Math.floor(openTimeMs / 1000),
          open:   d.open,
          high:   d.high,
          low:    d.low,
          close:  d.close,
          volume: d.volume,
        };

        if (lastOpenMs !== null && lastOpenMs !== openTimeMs && lastCandle) {
          onCandle({ ...lastCandle, closed: true });
        }
        lastOpenMs = openTimeMs;
        lastCandle = candle;
        onCandle({ ...candle, closed: false });
      });

      ws.on('error', e => console.error('[WS] error:', e.message));
      ws.on('close', () => {
        clearInterval(pingTimer);
        console.log('[WS] disconnected — reconnecting in 5s');
        setTimeout(connect, 5000);
      });
    };

    connect();
  }
}

module.exports = { KuCoinClient };
