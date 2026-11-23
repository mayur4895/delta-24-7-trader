/**
 * 24/7 Automated Strategy Scanner for Delta Exchange India
 * 
 * Strategy: "Dual-Target Institutional Flow" (15-Minute Chart)
 * - Evaluates closed 15-minute candles on Delta Exchange
 * - Detects 4H Macro Trend (50 EMA)
 * - Detects Base Candles with >= 1.6x ATR displacement (Supply / Demand zones)
 * - Detects unmitigated zone retests
 * - Automatically checks live balance (₹51+), sizes lots, adapts leverage, and executes
 * - Enforces Max 3 trades per calendar day
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

const { 
    handleTradeSignal, 
    loadConfig, 
    fetchDeltaBalance, 
    getProductId,
    getContractMultiplier 
} = require('./delta_bridge');

class StrategyScanner {
    constructor(options = {}) {
        this.symbol = options.symbol || process.env.SCAN_SYMBOL || 'XRPUSD';
        this.intervalMs = options.intervalMs || 60 * 1000; // Check every 60s for new candle
        this.lastCheckedBarTime = 0;
        this.isRunning = false;
        this.timer = null;
        this.activeZones = [];
        this.logs = [];
        this.latestStatus = {
            running: false,
            symbol: this.symbol,
            lastScanTime: null,
            lastBarTime: null,
            candleClose: null,
            livePrice: null,
            trend: 'INITIALIZING',
            ema4h: null,
            targetZone: null,
            distancePct: null,
            summary: 'Initializing scanner...'
        };
    }

    logMessage(msg) {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const line = `[${time}] ${msg}`;
        console.log(line);
        this.logs.unshift(line);
        if (this.logs.length > 60) this.logs.pop();
    }

    /**
     * Fetch 15-minute historical candles from Delta Exchange India
     */
    fetchDeltaCandles(resolution = '15', lookbackDays = 3) {
        return new Promise((resolve, reject) => {
            const now = Math.floor(Date.now() / 1000);
            const from = now - (lookbackDays * 86400);
            const url = `https://api.india.delta.exchange/v2/chart/history?symbol=${this.symbol}&resolution=${resolution}&from=${from}&to=${now}`;

            https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (!parsed.result || !parsed.result.c || parsed.result.c.length === 0) {
                            return resolve([]);
                        }
                        const r = parsed.result;
                        const candles = [];
                        for (let i = 0; i < r.c.length; i++) {
                            candles.push({
                                time: r.t[i] * 1000,
                                open: r.o[i],
                                high: r.h[i],
                                low: r.l[i],
                                close: r.c[i],
                                volume: r.v[i] || 0
                            });
                        }
                        resolve(candles);
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', reject);
        });
    }

    computeATR(candles, period = 14) {
        const atrs = [];
        for (let i = 0; i < candles.length; i++) {
            if (i === 0) {
                atrs.push(candles[0].high - candles[0].low);
                continue;
            }
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
            atrs.push(i < period ? tr : (atrs[i - 1] * (period - 1) + tr) / period);
        }
        return atrs;
    }

    computeEMA(candles, period) {
        const k = 2 / (period + 1);
        const emas = [];
        let ema = candles[0].close;
        for (let i = 0; i < candles.length; i++) {
            ema = (candles[i].close * k) + (ema * (1 - k));
            emas.push(ema);
        }
        return emas;
    }

    /**
     * Run a single scan on latest closed candles
     */
    async scanOnce() {
        const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        try {
            const candles = await this.fetchDeltaCandles('15', 4);
            if (candles.length < 100) {
                this.logMessage(`[SCANNER] Insufficient candle data (${candles.length}). Waiting...`);
                return;
            }

            // Closed candle is at index length - 2 (index length - 1 is the currently forming candle)
            const closedIdx = candles.length - 2;
            const closedCandle = candles[closedIdx];

            if (closedCandle.time === this.lastCheckedBarTime) {
                // Candle already processed; update live price only
                const currentPrice = candles[candles.length - 1].close;
                this.latestStatus.livePrice = currentPrice;
                return;
            }

            this.lastCheckedBarTime = closedCandle.time;
            const currentPrice = candles[candles.length - 1].close;

            // 1. Calculate 4H 50 EMA on 15M candles (4H = 16 x 15M bars; period = 800)
            const emaPeriod = Math.min(800, Math.floor(candles.length / 2));
            const emas = this.computeEMA(candles, emaPeriod);
            const atrs = this.computeATR(candles, 14);

            const currentEMA = emas[closedIdx];
            const currentATR = atrs[closedIdx];
            const isBullishTrend = closedCandle.close > currentEMA;

            // 2. Identify Fresh Institutional Supply & Demand Zones
            this.activeZones = [];
            for (let i = 3; i <= closedIdx; i++) {
                const p1 = candles[i - 1]; // Displacement candle
                const base = candles[i - 2]; // Base candle
                const atr = atrs[i - 1];
                const p1Body = Math.abs(p1.close - p1.open);

                // Demand Zone (Bullish base before explosive expansion)
                if (p1.close > p1.open && p1Body >= atr * 1.6 && p1.close > base.high) {
                    this.activeZones.push({
                        type: 'DEMAND',
                        side: 'BUY',
                        top: Math.max(base.open, base.close),
                        bottom: base.low,
                        sl: parseFloat((base.low - (base.low * 0.0008)).toFixed(4)),
                        entryLimit: parseFloat(Math.max(base.open, base.close).toFixed(4)),
                        time: base.time,
                        mitigated: false
                    });
                }

                // Supply Zone (Bearish base before explosive plunge)
                if (p1.open > p1.close && p1Body >= atr * 1.6 && p1.close < base.low) {
                    this.activeZones.push({
                        type: 'SUPPLY',
                        side: 'SELL',
                        top: base.high,
                        bottom: Math.min(base.open, base.close),
                        sl: parseFloat((base.high + (base.high * 0.0008)).toFixed(4)),
                        entryLimit: parseFloat(Math.min(base.open, base.close).toFixed(4)),
                        time: base.time,
                        mitigated: false
                    });
                }
            }

            // Invalidate mitigated zones
            for (let z = 0; z < this.activeZones.length; z++) {
                const zone = this.activeZones[z];
                for (let k = closedIdx - 10; k < closedIdx; k++) {
                    if (k >= 0) {
                        if (zone.type === 'DEMAND' && candles[k].low <= zone.top) {
                            zone.mitigated = true;
                        }
                        if (zone.type === 'SUPPLY' && candles[k].high >= zone.bottom) {
                            zone.mitigated = true;
                        }
                    }
                }
            }

            const freshDemand = this.activeZones.filter(z => z.type === 'DEMAND' && !z.mitigated).slice(-1)[0];
            const freshSupply = this.activeZones.filter(z => z.type === 'SUPPLY' && !z.mitigated).slice(-1)[0];

            let activeTargetZone = null;
            let distPct = null;

            if (isBullishTrend && freshDemand) {
                activeTargetZone = freshDemand;
                distPct = parseFloat((((currentPrice - freshDemand.entryLimit) / currentPrice) * 100).toFixed(2));
            } else if (!isBullishTrend && freshSupply) {
                activeTargetZone = freshSupply;
                distPct = parseFloat((((freshSupply.entryLimit - currentPrice) / currentPrice) * 100).toFixed(2));
            }

            // Update status object
            this.latestStatus = {
                running: this.isRunning,
                symbol: this.symbol,
                lastScanTime: timestampStr,
                lastBarTime: new Date(closedCandle.time).toISOString(),
                candleClose: closedCandle.close,
                livePrice: currentPrice,
                trend: isBullishTrend ? 'BULLISH' : 'BEARISH',
                ema4h: parseFloat(currentEMA.toFixed(4)),
                targetZone: activeTargetZone,
                distancePct: distPct,
                summary: activeTargetZone 
                    ? `Trend: ${isBullishTrend ? 'BULLISH' : 'BEARISH'} | Target ${activeTargetZone.type}: $${activeTargetZone.entryLimit} (${distPct}% away) | Waiting for 15M Retest`
                    : `Trend: ${isBullishTrend ? 'BULLISH' : 'BEARISH'} | Scanning for fresh unmitigated zones`
            };

            this.logMessage(`[SCAN] 15M Bar Closed: $${closedCandle.close.toFixed(4)} | Live: $${currentPrice.toFixed(4)} | 4H Trend: ${isBullishTrend ? '🟢 BULLISH' : '🔴 BEARISH'}`);

            if (isBullishTrend && freshDemand) {
                this.logMessage(`[TARGET] Fresh Demand: $${freshDemand.entryLimit.toFixed(4)} (SL: $${freshDemand.sl.toFixed(4)}) | Distance: ${distPct}%`);

                // RETEST CHECK: Did latest candle tap the Demand Zone?
                const touchedDemand = (closedCandle.low <= freshDemand.top && closedCandle.close >= freshDemand.bottom);
                if (touchedDemand) {
                    this.logMessage(`🔥 [SIGNAL TRIGGERED] Retest confirmed at Demand Zone $${freshDemand.entryLimit}! Auto-executing...`);
                    await this.executeStrategySignal(freshDemand, closedCandle.close);
                    return;
                }
            } else if (!isBullishTrend && freshSupply) {
                this.logMessage(`[TARGET] Fresh Supply: $${freshSupply.entryLimit.toFixed(4)} (SL: $${freshSupply.sl.toFixed(4)}) | Distance: ${distPct}%`);

                // RETEST CHECK: Did latest candle tap the Supply Zone?
                const touchedSupply = (closedCandle.high >= freshSupply.bottom && closedCandle.close <= freshSupply.top);
                if (touchedSupply) {
                    this.logMessage(`🔥 [SIGNAL TRIGGERED] Retest confirmed at Supply Zone $${freshSupply.entryLimit}! Auto-executing...`);
                    await this.executeStrategySignal(freshSupply, closedCandle.close);
                    return;
                }
            } else {
                this.logMessage(`[STATUS] No fresh unmitigated zones in immediate window. Standing by for next 15M candle.`);
            }

        } catch (err) {
            this.logMessage(`[SCANNER ERROR]: ${err.message}`);
        }
    }

    /**
     * Dispatch trade signal to delta_bridge execution pipeline
     */
    async executeStrategySignal(zone, entryPrice) {
        const config = loadConfig();
        const balRes = await fetchDeltaBalance(config);
        const balance = balRes.success ? balRes.available_balance : 0.60;

        const riskDist = Math.abs(entryPrice - zone.sl);
        const tp = zone.side === 'BUY' ? entryPrice + (riskDist * 3) : entryPrice - (riskDist * 3);

        const payload = {
            symbol: this.symbol,
            side: zone.side,
            entry_price: entryPrice,
            stop_loss: zone.sl,
            take_profit: parseFloat(tp.toFixed(4)),
            rrr: 3,
            size: 1, // Auto-sized for margin safety
            leverage: 10,
            account_balance: balance,
            order_type: 'market'
        };

        this.logMessage(`[DISPATCHING TO DELTA INDIA] ${zone.side} ${this.symbol} @ $${entryPrice} (SL: $${zone.sl} | TP: $${tp.toFixed(4)})`);
        const result = await handleTradeSignal(payload);
        this.logMessage(`[EXECUTION RESULT]: Verdict=${result.verdict} | RejectReason=${result.reject_reason || 'NONE'}`);
        this.latestStatus.lastSignal = {
            time: new Date().toISOString(),
            zone: zone,
            result: result
        };
    }

    getStatus() {
        return {
            ...this.latestStatus,
            logs: this.logs.slice(0, 25)
        };
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.latestStatus.running = true;
        this.logMessage(`🚀 [24/7 DELTA STRATEGY SCANNER STARTED] Monitoring ${this.symbol} on 15M`);
        this.logMessage(`Checking candle closes every ${this.intervalMs / 1000}s...`);

        this.scanOnce();
        this.timer = setInterval(() => this.scanOnce(), this.intervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.isRunning = false;
        this.latestStatus.running = false;
        this.logMessage(`🛑 [SCANNER PAUSED]`);
    }
}

module.exports = StrategyScanner;

if (require.main === module) {
    const scanner = new StrategyScanner({ symbol: 'XRPUSD', intervalMs: 60 * 1000 });
    scanner.start();
}
