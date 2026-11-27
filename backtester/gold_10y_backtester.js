/**
 * Gold (XAUUSD / GC=F) 10-Year Institutional Strategy Backtest
 * 
 * Strategy Rules Tested:
 * 1. Trend Alignment: Macro EMA Filter (Buys strictly in Uptrend, Sells strictly in Downtrend)
 * 2. Institutional Displacement: Base candle followed by explosive expansion (>= 1.5x ATR)
 * 3. Fresh Zone Retest: Entry upon retest of unmitigated Demand/Supply zones
 * 4. Strict 1:3 RRR: Take Profit = Entry +/- 3 * (Risk Distance)
 * 5. Capital Risk Management: 5.0% equity risk per trade with compounding
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class GoldBacktester {
    constructor(options = {}) {
        this.rrr = options.rrr || 3.0; // Strict 1:3 RRR
        this.displacementMult = options.displacementMult || 1.5;
        this.atrPeriod = options.atrPeriod || 14;
        this.emaPeriod = options.emaPeriod || 50;
        this.capitalRiskPct = options.capitalRiskPct || 0.05; // 5% risk per trade
        this.initialCapital = options.initialCapital || 1000.0;
    }

    fetchCandles(interval = '1d', range = '10y') {
        return new Promise((resolve, reject) => {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
            https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
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
                                year: d.getUTCFullYear(),
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
                const prev = atrs[i - 1];
                atrs.push((prev * (this.atrPeriod - 1) + tr) / this.atrPeriod);
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

    run(candles, label = '10-Year Daily') {
        const atrs = this.computeATR(candles);
        const emas = this.computeEMA(candles, this.emaPeriod);

        const demandZones = [];
        const supplyZones = [];
        const trades = [];
        let activeTrade = null;

        let balance = this.initialCapital;
        let peakBalance = this.initialCapital;
        let maxDrawdownPct = 0;

        for (let i = this.emaPeriod; i < candles.length; i++) {
            const current = candles[i];
            const prev = candles[i - 1];
            const base = candles[i - 2];
            const atr = atrs[i - 1];
            const ema = emas[i];

            // 1. Evaluate Active Trade
            if (activeTrade) {
                let closed = false;
                if (activeTrade.side === 'BUY') {
                    if (current.low <= activeTrade.stopLoss) {
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.exitDate = current.dateStr;
                        activeTrade.result = 'LOSS';
                        activeTrade.pnlR = -1.0;
                        activeTrade.pnlUsd = -1 * (activeTrade.capitalAtEntry * this.capitalRiskPct);
                        closed = true;
                    } else if (current.high >= activeTrade.takeProfit) {
                        activeTrade.exitPrice = activeTrade.takeProfit;
                        activeTrade.exitDate = current.dateStr;
                        activeTrade.result = 'WIN';
                        activeTrade.pnlR = this.rrr;
                        activeTrade.pnlUsd = this.rrr * (activeTrade.capitalAtEntry * this.capitalRiskPct);
                        closed = true;
                    }
                } else if (activeTrade.side === 'SELL') {
                    if (current.high >= activeTrade.stopLoss) {
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.exitDate = current.dateStr;
                        activeTrade.result = 'LOSS';
                        activeTrade.pnlR = -1.0;
                        activeTrade.pnlUsd = -1 * (activeTrade.capitalAtEntry * this.capitalRiskPct);
                        closed = true;
                    } else if (current.low <= activeTrade.takeProfit) {
                        activeTrade.exitPrice = activeTrade.takeProfit;
                        activeTrade.exitDate = current.dateStr;
                        activeTrade.result = 'WIN';
                        activeTrade.pnlR = this.rrr;
                        activeTrade.pnlUsd = this.rrr * (activeTrade.capitalAtEntry * this.capitalRiskPct);
                        closed = true;
                    }
                }

                if (closed) {
                    balance += activeTrade.pnlUsd;
                    activeTrade.finalBalance = balance;
                    trades.push({ ...activeTrade });
                    activeTrade = null;

                    if (balance > peakBalance) peakBalance = balance;
                    const dd = ((peakBalance - balance) / peakBalance) * 100;
                    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
                }
            }

            // 2. Zone Retest Entry Trigger (if no active trade)
            if (!activeTrade) {
                // Uptrend -> Retest of Demand Zone
                if (current.close > ema) {
                    for (let z = demandZones.length - 1; z >= 0; z--) {
                        const zone = demandZones[z];
                        if (zone.mitigated) continue;

                        // Invalidation: Price closed well below zone
                        if (current.low < zone.bottom - zone.riskDist) {
                            zone.mitigated = true;
                            continue;
                        }

                        // Retest: Candle dipped into zone entry
                        if (current.low <= zone.top && current.high >= zone.top) {
                            zone.mitigated = true;
                            const entry = zone.top;
                            const sl = zone.bottom;
                            const risk = entry - sl;
                            if (risk <= 0 || (risk / entry) > 0.05) continue; // Filter unrealistic wide zones
                            const tp = entry + (risk * this.rrr);

                            activeTrade = {
                                tradeNum: trades.length + 1,
                                side: 'BUY',
                                entryDate: current.dateStr,
                                year: current.year,
                                entryPrice: parseFloat(entry.toFixed(2)),
                                stopLoss: parseFloat(sl.toFixed(2)),
                                takeProfit: parseFloat(tp.toFixed(2)),
                                riskUsd: parseFloat(risk.toFixed(2)),
                                capitalAtEntry: balance
                            };
                            break;
                        }
                    }
                }
                // Downtrend -> Retest of Supply Zone
                else if (current.close < ema) {
                    for (let z = supplyZones.length - 1; z >= 0; z--) {
                        const zone = supplyZones[z];
                        if (zone.mitigated) continue;

                        // Invalidation: Price closed well above zone
                        if (current.high > zone.top + zone.riskDist) {
                            zone.mitigated = true;
                            continue;
                        }

                        // Retest: Candle rallied into supply zone
                        if (current.high >= zone.bottom && current.low <= zone.bottom) {
                            zone.mitigated = true;
                            const entry = zone.bottom;
                            const sl = zone.top;
                            const risk = sl - entry;
                            if (risk <= 0 || (risk / entry) > 0.05) continue;
                            const tp = entry - (risk * this.rrr);

                            activeTrade = {
                                tradeNum: trades.length + 1,
                                side: 'SELL',
                                entryDate: current.dateStr,
                                year: current.year,
                                entryPrice: parseFloat(entry.toFixed(2)),
                                stopLoss: parseFloat(sl.toFixed(2)),
                                takeProfit: parseFloat(tp.toFixed(2)),
                                riskUsd: parseFloat(risk.toFixed(2)),
                                capitalAtEntry: balance
                            };
                            break;
                        }
                    }
                }
            }

            // 3. Zone Creation Logic (Displacement check)
            const prevBody = Math.abs(prev.close - prev.open);
            const isBullishDisp = prev.close > prev.open && prevBody >= (atr * this.displacementMult) && prev.close > base.high;
            if (isBullishDisp) {
                demandZones.push({
                    top: Math.max(base.open, base.close),
                    bottom: base.low,
                    riskDist: base.high - base.low,
                    mitigated: false
                });
            }

            const isBearishDisp = prev.open > prev.close && prevBody >= (atr * this.displacementMult) && prev.close < base.low;
            if (isBearishDisp) {
                supplyZones.push({
                    top: base.high,
                    bottom: Math.min(base.open, base.close),
                    riskDist: base.high - base.low,
                    mitigated: false
                });
            }
        }

        // Performance Metrics
        const totalTrades = trades.length;
        const wins = trades.filter(t => t.result === 'WIN').length;
        const losses = trades.filter(t => t.result === 'LOSS').length;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
        const netR = (wins * this.rrr) - (losses * 1.0);
        const profitFactor = losses > 0 ? ((wins * this.rrr) / losses).toFixed(2) : 'N/A';
        const totalReturnPct = (((balance - this.initialCapital) / this.initialCapital) * 100).toFixed(1);

        // Year-by-Year breakdown
        const yearly = {};
        trades.forEach(t => {
            const yr = t.year;
            if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, losses: 0, netR: 0, profitUsd: 0 };
            yearly[yr].trades++;
            if (t.result === 'WIN') {
                yearly[yr].wins++;
                yearly[yr].netR += this.rrr;
            } else {
                yearly[yr].losses++;
                yearly[yr].netR -= 1.0;
            }
            yearly[yr].profitUsd += t.pnlUsd;
        });

        return {
            label,
            totalCandles: candles.length,
            startDate: candles[0].dateStr,
            endDate: candles[candles.length - 1].dateStr,
            initialCapital: this.initialCapital,
            finalBalance: parseFloat(balance.toFixed(2)),
            totalReturnPct: `${totalReturnPct}%`,
            netR: `${netR > 0 ? '+' : ''}${netR.toFixed(1)}R`,
            totalTrades,
            wins,
            losses,
            winRate: `${winRate}%`,
            profitFactor,
            maxDrawdownPct: `${maxDrawdownPct.toFixed(1)}%`,
            yearly,
            sampleTrades: trades.slice(-8)
        };
    }
}

async function runFullGoldTest() {
    console.log('=============================================================');
    console.log('   GOLD (XAUUSD) 10-YEAR HISTORICAL STRATEGY BACKTEST');
    console.log('   Strategy: Institutional Supply/Demand Flow (1:3 RRR | 5% Risk)');
    console.log('=============================================================\n');

    const tester = new GoldBacktester({
        rrr: 3.0,
        displacementMult: 1.5,
        capitalRiskPct: 0.05,
        initialCapital: 1000.0
    });

    console.log('1. Fetching 10 Years of Daily Gold Candles (2016 - 2026)...');
    const dailyCandles = await tester.fetchCandles('1d', '10y');
    console.log(`Loaded ${dailyCandles.length} daily bars from ${dailyCandles[0].dateStr} to ${dailyCandles[dailyCandles.length - 1].dateStr}.`);

    const dailyResults = tester.run(dailyCandles, '10-Year Daily Benchmark (2016-2026)');

    console.log('\n2. Fetching 2-Year High-Resolution Intraday Gold Candles (1-Hour)...');
    const hourlyCandles = await tester.fetchCandles('1h', '730d');
    console.log(`Loaded ${hourlyCandles.length} hourly bars from ${hourlyCandles[0].dateStr} to ${hourlyCandles[hourlyCandles.length - 1].dateStr}.`);

    const hourlyResults = tester.run(hourlyCandles, '2-Year Intraday Hourly Benchmark');

    return { dailyResults, hourlyResults };
}

if (require.main === module) {
    runFullGoldTest().then(res => {
        console.log('\n=============================================================');
        console.log('               10-YEAR DAILY GOLD BACKTEST RESULTS           ');
        console.log('=============================================================');
        console.log(`Period:           ${res.dailyResults.startDate} to ${res.dailyResults.endDate} (${res.dailyResults.totalCandles} trading days)`);
        console.log(`Initial Capital:  $${res.dailyResults.initialCapital.toFixed(2)}`);
        console.log(`Final Capital:    $${res.dailyResults.finalBalance.toFixed(2)} (${res.dailyResults.totalReturnPct})`);
        console.log(`Total Return:     ${res.dailyResults.netR}`);
        console.log(`Total Trades:     ${res.dailyResults.totalTrades}`);
        console.log(`Win / Loss:       ${res.dailyResults.wins} Wins / ${res.dailyResults.losses} Losses`);
        console.log(`Win Rate:         ${res.dailyResults.winRate}`);
        console.log(`Profit Factor:    ${res.dailyResults.profitFactor}`);
        console.log(`Max Drawdown:     ${res.dailyResults.maxDrawdownPct}`);
        console.log('\nYear-by-Year Performance Breakdown:');
        console.table(res.dailyResults.yearly);

        console.log('\n=============================================================');
        console.log('            2-YEAR HIGH-RESOLUTION HOURLY BACKTEST RESULTS   ');
        console.log('=============================================================');
        console.log(`Period:           ${res.hourlyResults.startDate} to ${res.hourlyResults.endDate} (${res.hourlyResults.totalCandles} hourly bars)`);
        console.log(`Initial Capital:  $${res.hourlyResults.initialCapital.toFixed(2)}`);
        console.log(`Final Capital:    $${res.hourlyResults.finalBalance.toFixed(2)} (${res.hourlyResults.totalReturnPct})`);
        console.log(`Total Return:     ${res.hourlyResults.netR}`);
        console.log(`Total Trades:     ${res.hourlyResults.totalTrades}`);
        console.log(`Win / Loss:       ${res.hourlyResults.wins} Wins / ${res.hourlyResults.losses} Losses`);
        console.log(`Win Rate:         ${res.hourlyResults.winRate}`);
        console.log(`Profit Factor:    ${res.hourlyResults.profitFactor}`);
        console.log(`Max Drawdown:     ${res.hourlyResults.maxDrawdownPct}`);
    }).catch(console.error);
}

module.exports = { GoldBacktester, runFullGoldTest };
