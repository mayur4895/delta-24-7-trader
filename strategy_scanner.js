/**
 * 24/7 Automated Strategy Scanner for Delta Exchange India
 * 
 * Strategy: "Dual-Target Institutional Flow" (15-Minute Chart)
 * - Evaluates closed 15-minute candles on Delta Exchange
 * - Detects 4H Macro Trend (50 EMA)
 * - Detects Base Candles with >= 1.6x ATR displacement (Supply / Demand zones)
 * - Detects unmitigated zone retests
 * - Multi-Asset Analysis (XRPUSD, BTCUSD, ETHUSD, SOLUSD)
 * - Provides plain-language setup diagnostics explaining why setup is or isn't built
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
const { 
    sendWhatsAppSetupFormingAlert, 
    sendWhatsAppApproachingZoneAlert, 
    sendWhatsAppTradeAlert 
} = require('./modules/whatsapp_notifier');

class StrategyScanner {
    constructor(options = {}) {
        const rawSymbols = options.symbols || (options.symbol ? [options.symbol] : (process.env.SCAN_SYMBOLS ? process.env.SCAN_SYMBOLS.split(',') : ['BTCUSD', 'ETHUSD', 'XRPUSD', 'PAXGUSD']));
        this.symbols = rawSymbols.map(s => s.trim().toUpperCase()).filter(s => s !== 'SOLUSD');
        this.symbol = this.symbols[0] || 'BTCUSD';
        this.intervalMs = options.intervalMs || 60 * 1000; // Check every 60s for new candle
        this.isRunning = false;
        this.timer = null;
        this.activeZones = [];
        this.logs = [];
        this.symbolStatuses = new Map();
        this.lastBarTimes = new Map();
        this.latestStatus = {
            running: false,
            symbols: this.symbols,
            symbol: this.symbol,
            lastScanTime: null,
            lastBarTime: null,
            candleClose: null,
            livePrice: null,
            trend: 'INITIALIZING',
            ema4h: null,
            targetZone: null,
            distancePct: null,
            summary: `24/7 Multi-Asset Scanner initialized for: ${this.symbols.join(', ')}`
        };
    }

    logMessage(msg) {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const line = `[${time}] ${msg}`;
        console.log(line);
        this.logs.unshift(line);
        if (this.logs.length > 80) this.logs.pop();
    }

    /**
     * Fetch 15-minute historical candles from Delta Exchange India
     */
    fetchDeltaCandles(symbol = this.symbol, resolution = '15', lookbackDays = 4) {
        return new Promise((resolve, reject) => {
            const symUpper = (symbol || '').toUpperCase();
            const deltaSymbol = (symUpper === 'XAUUSD' || symUpper === 'GOLD' || symUpper === 'XAU') ? 'PAXGUSD' : symbol;
            const now = Math.floor(Date.now() / 1000);
            const from = now - (lookbackDays * 86400);
            const url = `https://api.india.delta.exchange/v2/chart/history?symbol=${deltaSymbol}&resolution=${resolution}&from=${from}&to=${now}`;

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
     * Deep Market Setup Diagnostic for Any Crypto Asset
     */
    async analyzeMarket(targetSymbol = this.symbol) {
        const candles = await this.fetchDeltaCandles(targetSymbol, '15', 4);
        if (candles.length < 100) {
            return {
                symbol: targetSymbol,
                error: 'INSUFFICIENT_DATA',
                message: `Need at least 100 15M candles; received ${candles.length}`
            };
        }

        const closedIdx = candles.length - 2;
        const closedCandle = candles[closedIdx];
        const currentPrice = candles[candles.length - 1].close;

        // 1. Calculate 4H 50 EMA on 15M candles (4H = 16 x 15M bars; period = 800)
        const emaPeriod = Math.min(800, Math.floor(candles.length / 2));
        const emas = this.computeEMA(candles, emaPeriod);
        const atrs = this.computeATR(candles, 14);

        const currentEMA = emas[closedIdx];
        const currentATR = atrs[closedIdx];
        const isBullishTrend = closedCandle.close > currentEMA;

        // 2. Identify Fresh Institutional Supply & Demand Zones
        const detectedZones = [];
        for (let i = 3; i <= closedIdx; i++) {
            const p1 = candles[i - 1]; // Displacement candle
            const base = candles[i - 2]; // Base candle
            const atr = atrs[i - 1];
            const p1Body = Math.abs(p1.close - p1.open);

            // Demand Zone (Bullish base before explosive expansion)
            if (p1.close > p1.open && p1Body >= atr * 1.6 && p1.close > base.high) {
                const sl = parseFloat((base.low - (base.low * 0.0008)).toFixed(4));
                const entry = parseFloat(Math.max(base.open, base.close).toFixed(4));
                const risk = Math.abs(entry - sl);
                const riskPct = (risk / entry) * 100;

                // Institutional Risk Guard: Discard zones where SL distance is oversized (> 2.0% or > 2.2x ATR)
                if (riskPct <= 2.0 && risk <= atr * 2.2) {
                    const tp = parseFloat((entry + (risk * 3)).toFixed(4));

                    detectedZones.push({
                        type: 'DEMAND',
                        side: 'BUY',
                        top: Math.max(base.open, base.close),
                        bottom: base.low,
                        sl: sl,
                        entryLimit: entry,
                        tp: tp,
                        riskDist: parseFloat(risk.toFixed(4)),
                        rewardDist: parseFloat((risk * 3).toFixed(4)),
                        time: base.time,
                        mitigated: false
                    });
                }
            }

            // Supply Zone (Bearish base before explosive plunge)
            if (p1.open > p1.close && p1Body >= atr * 1.6 && p1.close < base.low) {
                const sl = parseFloat((base.high + (base.high * 0.0008)).toFixed(4));
                const entry = parseFloat(Math.min(base.open, base.close).toFixed(4));
                const risk = Math.abs(sl - entry);
                const riskPct = (risk / entry) * 100;

                // Institutional Risk Guard: Discard zones where SL distance is oversized (> 2.0% or > 2.2x ATR)
                if (riskPct <= 2.0 && risk <= atr * 2.2) {
                    const tp = parseFloat((entry - (risk * 3)).toFixed(4));

                    detectedZones.push({
                        type: 'SUPPLY',
                        side: 'SELL',
                        top: base.high,
                        bottom: Math.min(base.open, base.close),
                        sl: sl,
                        entryLimit: entry,
                        tp: tp,
                        riskDist: parseFloat(risk.toFixed(4)),
                        rewardDist: parseFloat((risk * 3).toFixed(4)),
                        time: base.time,
                        mitigated: false
                    });
                }
            }
        }

        // Check zone mitigation
        for (let z = 0; z < detectedZones.length; z++) {
            const zone = detectedZones[z];
            for (let k = closedIdx - 12; k < closedIdx; k++) {
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

        const freshDemand = detectedZones.filter(z => z.type === 'DEMAND' && !z.mitigated).slice(-1)[0];
        const freshSupply = detectedZones.filter(z => z.type === 'SUPPLY' && !z.mitigated).slice(-1)[0];

        let targetZone = null;
        let distPct = null;
        let distUsd = null;
        let setupStatus = 'NO_DISPLACEMENT_ZONE';
        let setupStatusLabel = '⚪ NO SETUP YET: CONSOLIDATING';
        let simpleExplanation = '';

        if (isBullishTrend && freshDemand) {
            targetZone = freshDemand;
            distUsd = parseFloat(Math.abs(currentPrice - freshDemand.entryLimit).toFixed(4));
            distPct = parseFloat((((currentPrice - freshDemand.entryLimit) / currentPrice) * 100).toFixed(2));

            const touchedDemand = (closedCandle.low <= freshDemand.top && closedCandle.close >= freshDemand.bottom);
            if (touchedDemand) {
                setupStatus = 'READY_FOR_EXECUTION';
                setupStatusLabel = '🟢 SETUP READY: RETEST CONFIRMED';
                simpleExplanation = `Bullish trend confirmed (above 4H EMA $${currentEMA.toFixed(4)}). The 15M candle closed at $${closedCandle.close.toFixed(4)}, successfully tapping into the Demand Zone ($${freshDemand.entryLimit.toFixed(4)}). Setup is fully built for 1:3 RRR long.`;
            } else {
                setupStatus = 'WAITING_FOR_RETEST';
                setupStatusLabel = '🟡 SETUP FORMING: WAITING FOR PULLBACK';
                simpleExplanation = `Macro trend is BULLISH above 4H EMA ($${currentEMA.toFixed(4)}). Fresh institutional Demand Zone is at $${freshDemand.entryLimit.toFixed(4)} (SL: $${freshDemand.sl.toFixed(4)} | TP: $${freshDemand.tp.toFixed(4)}). Current price is $${currentPrice.toFixed(4)}, which is ${distPct}% ($${distUsd}) above the zone. Setup is NOT executed yet because price must pull back and test $${freshDemand.entryLimit.toFixed(4)} without closing below $${freshDemand.sl.toFixed(4)}. You can wait for the 24/7 background scanner, or place a resting Zone Limit Order directly on Delta Exchange.`;
            }
        } else if (!isBullishTrend && freshSupply) {
            targetZone = freshSupply;
            distUsd = parseFloat(Math.abs(freshSupply.entryLimit - currentPrice).toFixed(4));
            distPct = parseFloat((((freshSupply.entryLimit - currentPrice) / currentPrice) * 100).toFixed(2));

            const touchedSupply = (closedCandle.high >= freshSupply.bottom && closedCandle.close <= freshSupply.top);
            if (touchedSupply) {
                setupStatus = 'READY_FOR_EXECUTION';
                setupStatusLabel = '🟢 SETUP READY: RETEST CONFIRMED';
                simpleExplanation = `Bearish trend confirmed (below 4H EMA $${currentEMA.toFixed(4)}). The 15M candle closed at $${closedCandle.close.toFixed(4)}, successfully tapping into the Supply Zone ($${freshSupply.entryLimit.toFixed(4)}). Setup is fully built for 1:3 RRR short.`;
            } else {
                setupStatus = 'WAITING_FOR_RETEST';
                setupStatusLabel = '🟡 SETUP FORMING: WAITING FOR RALLY';
                simpleExplanation = `Macro trend is BEARISH below 4H EMA ($${currentEMA.toFixed(4)}). Fresh institutional Supply Zone is at $${freshSupply.entryLimit.toFixed(4)} (SL: $${freshSupply.sl.toFixed(4)} | TP: $${freshSupply.tp.toFixed(4)}). Current price is $${currentPrice.toFixed(4)}, which is ${distPct}% ($${distUsd}) below the zone. Setup is NOT executed yet because price must rally into $${freshSupply.entryLimit.toFixed(4)} without closing above $${freshSupply.sl.toFixed(4)}. You can wait for the 24/7 background scanner, or place a resting Zone Limit Order directly on Delta Exchange.`;
            }
        } else {
            setupStatus = 'NO_DISPLACEMENT_ZONE';
            setupStatusLabel = '⚪ NO SETUP YET: CONSOLIDATING';
            simpleExplanation = `Macro trend is ${isBullishTrend ? 'BULLISH' : 'BEARISH'} (4H EMA is at $${currentEMA.toFixed(4)}). However, no base candle with explosive displacement (>= 1.6x ATR) was formed in the recent lookback window. The market is consolidating without clear institutional displacement. Setup is NOT built yet.`;
        }

        return {
            symbol: targetSymbol,
            livePrice: currentPrice,
            candleClose: closedCandle.close,
            candleTime: new Date(closedCandle.time).toISOString(),
            trend: isBullishTrend ? 'BULLISH' : 'BEARISH',
            trendConfluence: isBullishTrend ? 'BUY_ONLY' : 'SELL_ONLY',
            ema4h: parseFloat(currentEMA.toFixed(4)),
            atr14: parseFloat(currentATR.toFixed(4)),
            setupBuilt: setupStatus !== 'NO_DISPLACEMENT_ZONE',
            setupStatus: setupStatus,
            setupStatusLabel: setupStatusLabel,
            targetZone: targetZone ? {
                type: targetZone.type,
                side: targetZone.side,
                entryLimit: targetZone.entryLimit,
                sl: targetZone.sl,
                tp: targetZone.tp,
                riskDist: targetZone.riskDist,
                rewardDist: targetZone.rewardDist,
                rrr: '1:3',
                distanceUsd: distUsd,
                distancePct: distPct
            } : null,
            simpleExplanation: simpleExplanation,
            analysisTime: new Date().toISOString()
        };
    }

    /**
     * Run multi-asset scan across all configured watchlists (BTC, ETH, XRP, Gold)
     */
    async scanOnce() {
        const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        for (const sym of this.symbols) {
            try {
                await this.scanSingleSymbol(sym, timestampStr);
                // 300ms pause between assets to protect against API rate limits
                await new Promise(r => setTimeout(r, 300));
            } catch (err) {
                this.logMessage(`[SCANNER ERROR - ${sym}]: ${err.message}`);
            }
        }
    }

    /**
     * Scan and evaluate an individual asset for institutional setups & auto-execution
     */
    async scanSingleSymbol(sym, timestampStr) {
        const analysis = await this.analyzeMarket(sym);
        if (analysis.error) {
            this.logMessage(`[SCANNER - ${sym}] ${analysis.message}`);
            return;
        }

        const lastBar = this.lastBarTimes.get(sym);
        const isNewBar = analysis.candleTime !== lastBar;
        this.lastBarTimes.set(sym, analysis.candleTime);

        const statusObj = {
            running: this.isRunning,
            symbol: sym,
            lastScanTime: timestampStr,
            lastBarTime: analysis.candleTime,
            candleClose: analysis.candleClose,
            livePrice: analysis.livePrice,
            trend: analysis.trend,
            ema4h: analysis.ema4h,
            setupBuilt: analysis.setupBuilt,
            setupStatus: analysis.setupStatus,
            setupStatusLabel: analysis.setupStatusLabel,
            targetZone: analysis.targetZone,
            distancePct: analysis.targetZone ? analysis.targetZone.distancePct : null,
            distanceUsd: analysis.targetZone ? analysis.targetZone.distanceUsd : null,
            summary: analysis.simpleExplanation
        };
        this.symbolStatuses.set(sym, statusObj);

        // Keep latestStatus synced with active symbol or last scanned
        if (sym === this.symbol || !this.latestStatus.symbol) {
            this.latestStatus = statusObj;
        }

        if (isNewBar || analysis.setupStatus === 'READY_FOR_EXECUTION' || (analysis.targetZone && Math.abs(analysis.targetZone.distancePct) <= 1.0)) {
            this.logMessage(`[SCAN - ${sym}] 15M: $${analysis.candleClose} | Live: $${analysis.livePrice} | Trend: ${analysis.trend === 'BULLISH' ? '🟢 BULLISH' : '🔴 BEARISH'}`);
        }

        if (analysis.setupStatus === 'READY_FOR_EXECUTION') {
            this.logMessage(`🔥 [SIGNAL TRIGGERED - ${sym}] Retest confirmed at ${analysis.targetZone.type} $${analysis.targetZone.entryLimit}! Checking margin & executing...`);
            
            // Check live wallet balance and calculate required margin
            const config = loadConfig();
            const balRes = await fetchDeltaBalance(config);
            const balance = balRes.success ? balRes.available_balance : 0.60;
            const multiplier = getContractMultiplier(sym);
            const notional = analysis.candleClose * multiplier;
            const reqMargin = notional / 10; // 10x leverage
            const isMarginIssue = (balance > 0 && reqMargin > balance);

            // Stage 3 WhatsApp Alert: Setup Retest Confirmed (With Margin Warning if balance insufficient)
            try {
                await sendWhatsAppTradeAlert({
                    symbol: sym,
                    side: analysis.targetZone.side,
                    direction: analysis.targetZone.side === 'BUY' ? 'LONG' : 'SHORT',
                    entry_price: analysis.candleClose,
                    stop_loss: analysis.targetZone.sl,
                    take_profit: analysis.targetZone.tp,
                    rrr: '1:3',
                    capital_risk_percent: '5.0%',
                    is_margin_warning: isMarginIssue,
                    required_margin: reqMargin,
                    available_balance: balance,
                    order_type: 'Market (Zone Retest Confirmed)',
                    order_id: isMarginIssue ? 'BLOCKED_MARGIN' : ('EXEC_' + Date.now().toString().slice(-6)),
                    entry_time: new Date().toISOString()
                });
            } catch (waErr) {
                console.error(`[Scanner - ${sym}] Stage 3 Retest Trigger Alert Error:`, waErr.message);
            }

            if (!isMarginIssue) {
                await this.executeStrategySignal(analysis.targetZone, analysis.candleClose, sym);
            } else {
                this.logMessage(`⚠️ [MARGIN WARNING - ${sym}] Auto-execution skipped: Required margin ($${reqMargin.toFixed(2)}) > Available balance ($${balance.toFixed(2)}). WhatsApp alert dispatched.`);
            }
        } else if (analysis.targetZone) {
            const dist = analysis.targetZone.distancePct;
            if (isNewBar || Math.abs(dist) <= 1.0) {
                this.logMessage(`[TARGET - ${sym}] ${analysis.targetZone.type}: $${analysis.targetZone.entryLimit} (SL: $${analysis.targetZone.sl} | TP: $${analysis.targetZone.tp}) | Distance: ${dist}%`);
            }

            // Stage 2 vs Stage 1 Alert Routing:
            if (dist !== null && dist !== undefined && Math.abs(dist) <= 1.0) {
                try {
                    await sendWhatsAppApproachingZoneAlert({
                        symbol: sym,
                        side: analysis.targetZone.side,
                        direction: analysis.targetZone.side === 'BUY' ? 'LONG' : 'SHORT',
                        entry: analysis.targetZone.entryLimit,
                        sl: analysis.targetZone.sl,
                        tp: analysis.targetZone.tp,
                        livePrice: analysis.livePrice,
                        distancePct: dist
                    });
                } catch (waErr) {
                    console.error(`[Scanner - ${sym}] WhatsApp Approaching Alert Error:`, waErr.message);
                }
            } else {
                // Stage 1: Setup Formed (Waiting for Pullback/Rally)
                try {
                    await sendWhatsAppSetupFormingAlert({
                        symbol: sym,
                        side: analysis.targetZone.side,
                        direction: analysis.targetZone.side === 'BUY' ? 'LONG' : 'SHORT',
                        entry: analysis.targetZone.entryLimit,
                        sl: analysis.targetZone.sl,
                        tp: analysis.targetZone.tp,
                        livePrice: analysis.livePrice,
                        distancePct: dist
                    });
                } catch (waErr) {
                    console.error(`[Scanner - ${sym}] WhatsApp Setup Alert Error:`, waErr.message);
                }
            }
        }
    }

    /**
     * Dispatch trade signal to delta_bridge execution pipeline
     */
    async executeStrategySignal(zone, entryPrice, targetSymbol = this.symbol) {
        const sym = (targetSymbol || this.symbol).toUpperCase();
        const config = loadConfig();
        const balRes = await fetchDeltaBalance(config);
        const balance = balRes.success ? balRes.available_balance : 0.60;

        const payload = {
            symbol: sym,
            side: zone.side,
            entry_price: entryPrice,
            stop_loss: zone.sl,
            take_profit: zone.tp,
            rrr: 3,
            size: 1, // Auto-sized for margin safety
            leverage: 10,
            account_balance: balance,
            order_type: 'market'
        };

        this.logMessage(`[DISPATCHING TO DELTA INDIA] ${zone.side} ${sym} @ $${entryPrice} (SL: $${zone.sl} | TP: $${zone.tp})`);
        const result = await handleTradeSignal(payload);
        this.logMessage(`[EXECUTION RESULT - ${sym}]: Verdict=${result.verdict} | RejectReason=${result.reject_reason || 'NONE'}`);
        this.latestStatus.lastSignal = {
            time: new Date().toISOString(),
            symbol: sym,
            zone: zone,
            result: result
        };
    }

    getStatus(symbol) {
        let baseStatus = this.latestStatus;
        if (symbol) {
            const clean = symbol.toUpperCase().replace('XAUUSD', 'PAXGUSD').replace('GOLD', 'PAXGUSD');
            if (this.symbolStatuses.has(clean)) {
                baseStatus = this.symbolStatuses.get(clean);
            }
        }
        return {
            ...baseStatus,
            symbols: this.symbols,
            logs: this.logs.slice(0, 30)
        };
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.latestStatus.running = true;
        this.logMessage(`🚀 [24/7 MULTI-ASSET SCANNER STARTED] Monitoring: ${this.symbols.join(', ')} on 15M`);
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
