/**
 * Institutional Supply & Demand Backtesting Engine (1-Year Benchmark)
 * 
 * Supports:
 * 1. Standard MT5 Exported CSV format (Date, Time, Open, High, Low, Close, Volume)
 * 2. Institutional Historical Candle Feeds (Gold GC=F, Forex, Crypto)
 * 
 * Rules:
 * - Identifies Base before explosive Displacement (Extended Range Candle / Imbalance)
 * - Retests of fresh unmitigated zones
 * - Trend alignment via 200 EMA (Only Buys above 200 EMA, Only Sells below 200 EMA)
 * - Strict 1:3 RRR (Take Profit = Entry +/- 3 * Risk)
 * - Circuit Breaker: Max 3 trades per calendar day
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class SupplyDemandBacktester {
    constructor(options = {}) {
        this.rrr = options.rrr || 3.0;
        this.maxTradesPerDay = options.maxTradesPerDay || 3;
        this.displacementMultiplier = options.displacementMultiplier || 1.4;
        this.atrPeriod = options.atrPeriod || 14;
        this.bufferPips = options.bufferPips || 1.0;
        this.emaPeriod = options.emaPeriod || 200;
    }

    async fetchHistoricalCandles(symbol = 'GC=F', interval = '1h', range = '1y') {
        return new Promise((resolve, reject) => {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
            https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const result = json.chart.result[0];
                        const timestamps = result.timestamp;
                        const quotes = result.indicators.quote[0];
                        const candles = [];

                        for (let i = 0; i < timestamps.length; i++) {
                            const o = quotes.open[i];
                            const h = quotes.high[i];
                            const l = quotes.low[i];
                            const c = quotes.close[i];
                            const v = quotes.volume[i] || 0;

                            if (o == null || h == null || l == null || c == null) continue;

                            const d = new Date(timestamps[i] * 1000);
                            candles.push({
                                time: timestamps[i] * 1000,
                                dateStr: d.toISOString().split('T')[0],
                                open: o, high: h, low: l, close: c, volume: v
                            });
                        }
                        resolve(candles);
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });
    }

    computeATR(candles) {
        const atrs = [];
        for (let i = 0; i < candles.length; i++) {
            if (i === 0) {
                atrs.push(candles[i].high - candles[i].low);
                continue;
            }
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
            if (i < this.atrPeriod) {
                atrs.push(tr);
            } else {
                const prevATR = atrs[i - 1];
                atrs.push((prevATR * (this.atrPeriod - 1) + tr) / this.atrPeriod);
            }
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

    runBacktest(candles) {
        const atrs = this.computeATR(candles);
        const emas = this.computeEMA(candles, this.emaPeriod);
        const demandZones = [];
        const supplyZones = [];
        const trades = [];
        const dailyTradeCount = {};
        let activeTrade = null;

        for (let i = this.emaPeriod; i < candles.length; i++) {
            const currentCandle = candles[i];
            const prevCandle = candles[i - 1];
            const baseCandle = candles[i - 2];
            const atr = atrs[i - 1];
            const currentEMA = emas[i];
            const dateStr = currentCandle.dateStr;

            if (!dailyTradeCount[dateStr]) dailyTradeCount[dateStr] = 0;

            // 1. Manage Active Trade
            if (activeTrade) {
                let closed = false;
                if (activeTrade.side === 'BUY') {
                    if (currentCandle.low <= activeTrade.stopLoss) {
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.result = 'LOSS';
                        activeTrade.pnlR = -1.0;
                        closed = true;
                    } else if (currentCandle.high >= activeTrade.takeProfit) {
                        activeTrade.exitPrice = activeTrade.takeProfit;
                        activeTrade.result = 'WIN';
                        activeTrade.pnlR = this.rrr;
                        closed = true;
                    }
                } else if (activeTrade.side === 'SELL') {
                    if (currentCandle.high >= activeTrade.stopLoss) {
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.result = 'LOSS';
                        activeTrade.pnlR = -1.0;
                        closed = true;
                    } else if (currentCandle.low <= activeTrade.takeProfit) {
                        activeTrade.exitPrice = activeTrade.takeProfit;
                        activeTrade.result = 'WIN';
                        activeTrade.pnlR = this.rrr;
                        closed = true;
                    }
                }
                if (closed) {
                    trades.push({ ...activeTrade });
                    activeTrade = null;
                }
            }

            // 2. Retest Entry with Trend Filter
            if (!activeTrade && dailyTradeCount[dateStr] < this.maxTradesPerDay) {
                // Uptrend -> Demand Buys
                if (currentCandle.close > currentEMA) {
                    for (let z = demandZones.length - 1; z >= 0; z--) {
                        const zone = demandZones[z];
                        if (zone.mitigated) continue;
                        if (currentCandle.low < zone.bottom - zone.riskDist) {
                            zone.mitigated = true;
                            continue;
                        }
                        if (currentCandle.low <= zone.top && currentCandle.high >= zone.top) {
                            zone.mitigated = true;
                            const entry = zone.top;
                            const stopLoss = zone.bottom - this.bufferPips;
                            const risk = entry - stopLoss;
                            if (risk <= 0) continue;
                            const takeProfit = entry + (risk * this.rrr);
                            activeTrade = {
                                tradeNumber: trades.length + 1,
                                side: 'BUY',
                                dateStr,
                                entryPrice: parseFloat(entry.toFixed(2)),
                                stopLoss: parseFloat(stopLoss.toFixed(2)),
                                takeProfit: parseFloat(takeProfit.toFixed(2)),
                                riskAmount: parseFloat(risk.toFixed(2)),
                                rrr: `1:${this.rrr}`
                            };
                            dailyTradeCount[dateStr]++;
                            break;
                        }
                    }
                } 
                // Downtrend -> Supply Sells
                else if (currentCandle.close < currentEMA) {
                    for (let z = supplyZones.length - 1; z >= 0; z--) {
                        const zone = supplyZones[z];
                        if (zone.mitigated) continue;
                        if (currentCandle.high > zone.top + zone.riskDist) {
                            zone.mitigated = true;
                            continue;
                        }
                        if (currentCandle.high >= zone.bottom && currentCandle.low <= zone.bottom) {
                            zone.mitigated = true;
                            const entry = zone.bottom;
                            const stopLoss = zone.top + this.bufferPips;
                            const risk = stopLoss - entry;
                            if (risk <= 0) continue;
                            const takeProfit = entry - (risk * this.rrr);
                            activeTrade = {
                                tradeNumber: trades.length + 1,
                                side: 'SELL',
                                dateStr,
                                entryPrice: parseFloat(entry.toFixed(2)),
                                stopLoss: parseFloat(stopLoss.toFixed(2)),
                                takeProfit: parseFloat(takeProfit.toFixed(2)),
                                riskAmount: parseFloat(risk.toFixed(2)),
                                rrr: `1:${this.rrr}`
                            };
                            dailyTradeCount[dateStr]++;
                            break;
                        }
                    }
                }
            }

            // 3. Zone Detection
            const prevBody = Math.abs(prevCandle.close - prevCandle.open);
            if (prevCandle.close > prevCandle.open && prevBody >= atr * this.displacementMultiplier && prevCandle.close > baseCandle.high) {
                demandZones.push({
                    top: Math.max(baseCandle.open, baseCandle.close),
                    bottom: baseCandle.low,
                    riskDist: baseCandle.high - baseCandle.low,
                    mitigated: false
                });
            }
            if (prevCandle.open > prevCandle.close && prevBody >= atr * this.displacementMultiplier && prevCandle.close < baseCandle.low) {
                supplyZones.push({
                    top: baseCandle.high,
                    bottom: Math.min(baseCandle.open, baseCandle.close),
                    riskDist: baseCandle.high - baseCandle.low,
                    mitigated: false
                });
            }
        }

        // Summary Calculations
        const totalTrades = trades.length;
        const wins = trades.filter(t => t.result === 'WIN').length;
        const losses = trades.filter(t => t.result === 'LOSS').length;
        const winRate = ((wins / totalTrades) * 100).toFixed(2);
        const grossProfitR = wins * this.rrr;
        const grossLossR = losses * 1.0;
        const netGainR = grossProfitR - grossLossR;
        const profitFactor = (grossProfitR / grossLossR).toFixed(2);

        // Monthly Breakdown
        const monthly = {};
        trades.forEach(t => {
            const m = t.dateStr.substring(0, 7);
            if (!monthly[m]) monthly[m] = { trades: 0, wins: 0, losses: 0, netR: 0 };
            monthly[m].trades++;
            if (t.result === 'WIN') { monthly[m].wins++; monthly[m].netR += this.rrr; }
            else { monthly[m].losses++; monthly[m].netR -= 1.0; }
        });

        return {
            summary: {
                totalCandlesAnalyzed: candles.length,
                dateRange: `${candles[0].dateStr} to ${candles[candles.length - 1].dateStr}`,
                totalTrades,
                wins,
                losses,
                winRate: `${winRate}%`,
                rrr: `1:${this.rrr}`,
                grossProfitR: `+${grossProfitR.toFixed(1)}R`,
                grossLossR: `-${grossLossR.toFixed(1)}R`,
                netGainR: `+${netGainR.toFixed(1)}R`,
                profitFactor
            },
            monthly,
            trades
        };
    }
}

module.exports = SupplyDemandBacktester;
