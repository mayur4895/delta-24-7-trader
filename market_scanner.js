/**
 * Standalone Autonomous Market Scanner (100% FREE - No TradingView Plan Needed)
 * 
 * Periodically fetches public candlestick data for BTC/ETH, computes EMA 20/50
 * crossover and ATR dynamic Stop-Loss, and pipes approved setups directly into
 * the Delta Exchange bridge.
 */

const https = require('https');
const { handleTradeSignal } = require('./delta_bridge');

// Configuration
const SYMBOL = 'BTC-PERP';
const RESOLUTION = '15m'; // 15-minute timeframe
const POLL_INTERVAL_MS = 60 * 1000; // Check every 1 minute
const EMA_FAST_PERIOD = 20;
const EMA_SLOW_PERIOD = 50;
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 1.5;

function fetchCandles(symbol = 'BTCUSDT', interval = '15m', limit = 100) {
    return new Promise((resolve, reject) => {
        // Public Binance Klines endpoint for reliable, free, real-time OHLCV data
        const cleanSymbol = symbol.replace('-PERP', '').replace('USD', 'USDT');
        const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`;

        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const raw = JSON.parse(data);
                    if (!Array.isArray(raw)) {
                        return reject(new Error('Invalid candle data received.'));
                    }
                    const candles = raw.map(c => ({
                        time: c[0],
                        open: parseFloat(c[1]),
                        high: parseFloat(c[2]),
                        low: parseFloat(c[3]),
                        close: parseFloat(c[4]),
                        volume: parseFloat(c[5])
                    }));
                    resolve(candles);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', err => reject(err));
    });
}

function calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    const emaArray = [];
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    emaArray[period - 1] = ema;

    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
        emaArray[i] = ema;
    }
    return emaArray;
}

function calculateATR(candles, period = 14) {
    const trArray = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trArray.push(tr);
    }
    const recentTR = trArray.slice(-period);
    return recentTR.reduce((a, b) => a + b, 0) / period;
}

let lastSignalTime = 0;

async function scanMarket() {
    try {
        console.log(`[Scanner] Scanning ${SYMBOL} on ${RESOLUTION} timeframe...`);
        const candles = await fetchCandles(SYMBOL, RESOLUTION, 100);
        if (candles.length < EMA_SLOW_PERIOD + 2) return;

        const closes = candles.map(c => c.close);
        const emaFast = calculateEMA(closes, EMA_FAST_PERIOD);
        const emaSlow = calculateEMA(closes, EMA_SLOW_PERIOD);
        const atr = calculateATR(candles, ATR_PERIOD);

        const currIdx = closes.length - 1;
        const prevIdx = closes.length - 2;

        const currClose = closes[currIdx];
        const fastNow = emaFast[currIdx];
        const fastPrev = emaFast[prevIdx];
        const slowNow = emaSlow[currIdx];
        const slowPrev = emaSlow[prevIdx];

        // Bullish Crossover: Fast EMA crosses ABOVE Slow EMA
        const isBullish = fastPrev <= slowPrev && fastNow > slowNow;
        // Bearish Crossunder: Fast EMA crosses BELOW Slow EMA
        const isBearish = fastPrev >= slowPrev && fastNow < slowNow;

        const currentCandleTime = candles[currIdx].time;

        if ((isBullish || isBearish) && currentCandleTime !== lastSignalTime) {
            lastSignalTime = currentCandleTime;
            const side = isBullish ? 'BUY' : 'SELL';
            const stopLoss = isBullish
                ? parseFloat((currClose - (atr * ATR_MULTIPLIER)).toFixed(2))
                : parseFloat((currClose + (atr * ATR_MULTIPLIER)).toFixed(2));

            console.log(`\n🚨 [Scanner Signal Detected] ${side} on ${SYMBOL} @ ${currClose} (SL: ${stopLoss})`);

            // Pipe through the complete Delta Bridge pipeline
            const result = await handleTradeSignal({
                symbol: SYMBOL,
                side: side,
                entry_price: currClose,
                stop_loss: stopLoss,
                rrr: 3,
                order_type: 'market'
            });

            console.log('[Scanner Outcome]:', JSON.stringify(result, null, 2));
        } else {
            console.log(`[Scanner] Monitoring. Price: ${currClose} | EMA${EMA_FAST_PERIOD}: ${fastNow.toFixed(1)} | EMA${EMA_SLOW_PERIOD}: ${slowNow.toFixed(1)}`);
        }
    } catch (err) {
        console.warn(`[Scanner Error]: ${err.message}`);
    }
}

function startScanner() {
    console.log('================================================================');
    console.log('🤖 AUTONOMOUS DELTA MARKET SCANNER STARTED (100% FREE - NO TV SUB)');
    console.log(`Symbol: ${SYMBOL} | Resolution: ${RESOLUTION} | RRR: 1:3`);
    console.log('================================================================');
    scanMarket();
    setInterval(scanMarket, POLL_INTERVAL_MS);
}

module.exports = { startScanner, scanMarket };

if (require.main === module) {
    startScanner();
}
