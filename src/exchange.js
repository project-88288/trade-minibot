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
  }

  _sign(params) {
    const qs  = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  _request(method, path, params = {}, signed = false) {
    return new Promise((resolve, reject) => {
      const qs  = signed ? this._sign(params) : new URLSearchParams(params).toString();
      const url = method === 'GET'
        ? `${this.restBase}${path}${qs ? '?' + qs : ''}`
        : `${this.restBase}${path}`;
      const body = method !== 'GET' ? qs : undefined;

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
  async fetchCandles(symbol, interval, limit = 500) {
    const path = this.futures ? '/fapi/v1/klines' : '/api/v3/klines';
    // Binance rejects limits above the endpoint max (futures 1500, spot 1000)
    limit = Math.min(limit, this.futures ? 1500 : 1000);
    const raw  = await this._request('GET', path, { symbol, interval, limit });
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

  // Enter a position — spends quoteCapital USDT at market price.
  // Returns { avgPrice, executedQty }
  async enterMarket(symbol, side, quoteCapital) {
    const params = { symbol, side: side.toUpperCase(), type: 'MARKET', quoteOrderQty: quoteCapital };
    if (this.futures) params.positionSide = 'BOTH';
    const order = await this._request('POST',
      this.futures ? '/fapi/v1/order' : '/api/v3/order', params, true);
    return {
      avgPrice:    _avgFillPrice(order),
      executedQty: parseFloat(order.executedQty),
    };
  }

  // Exit a position — sells exact baseQty at market price.
  // Returns { avgPrice }
  async exitMarket(symbol, side, baseQty) {
    const params = { symbol, side: side.toUpperCase(), type: 'MARKET', quantity: baseQty };
    if (this.futures) { params.positionSide = 'BOTH'; params.reduceOnly = 'true'; }
    const order = await this._request('POST',
      this.futures ? '/fapi/v1/order' : '/api/v3/order', params, true);
    return { avgPrice: _avgFillPrice(order) };
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
