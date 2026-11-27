/**
 * Bitcoin (BTC-USD / BTCUSDT) Historical Strategy Backtest
 * 
 * Tests Institutional Supply & Demand Flow on 10-Year and 5-Year BTC Data
 * Evaluates the new Risk-to-Reward Ratio settings:
 * - 1:2 RRR (New minimum threshold)
 * - 1:2.5 RRR
 * - 1:3 RRR (Institutional default)
 * - 1:4 RRR
 * - 1:5 RRR
 * 
 * Rules:
 * 1. Macro Trend Filter (50-period EMA on daily/hourly)
 * 2. Institutional Displacement (>= 1.5x ATR explosive move)
 * 3. Fresh unmitigated Supply & Demand Zone entries
 * 4. 5.0% equity risk per trade with position compounding
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class BTCBacktester {
    constructor(options = {}) {
        this.rrr = options.rrr || 3.0;
        this.displacementMult = options.displacementMult || 1.5;
        this.atrPeriod = options.atrPeriod || 14;
        this.emaPeriod = options.emaPeriod || 50;
        this.capitalRiskPct = options.capitalRiskPct || 0.05; // 5% risk per trade
        this.initialCapital = options.initialCapital || 1000.0;
    }

    fetchCandles(interval = '1d', range = '10y') {
        return new Promise((resolve, reject) => {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=${interval}&range=${range}`;
            https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
                        if (!json.chart || !json.chart.result || !json.chart.result[0]) {
                            throw new Error('Invalid response structure from Yahoo Finance');
                        }
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

    run(candles, label = 'BTC Backtest') {
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
                            if (risk <= 0 || (risk / entry) > 0.08) continue; // Filter unrealistic wide zones
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
                            if (risk <= 0 || (risk / entry) > 0.08) continue;
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
        const profitFactor = losses > 0 ? ((wins * this.rrr) / losses).toFixed(2) : (wins > 0 ? '99.0' : '0.0');
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
            rrr: `1:${this.rrr}`,
            totalCandles: candles.length,
            startDate: candles[0].dateStr,
            endDate: candles[candles.length - 1].dateStr,
            initialCapital: this.initialCapital,
            finalBalance: parseFloat(balance.toFixed(2)),
            totalReturnPct: `${totalReturnPct}%`,
            netR: `${netR > 0 ? '+' : ''}${netR.toFixed(1)}R`,
            netRValue: netR,
            totalTrades,
            wins,
            losses,
            winRate: `${winRate}%`,
            profitFactor,
            maxDrawdownPct: `${maxDrawdownPct.toFixed(1)}%`,
            yearly,
            sampleTrades: trades.slice(-6)
        };
    }
}

async function runBtcBacktests() {
    console.log('========================================================================');
    console.log('       BITCOIN (BTC-USD) 10-YEAR & 5-YEAR HISTORICAL STRATEGY BACKTEST   ');
    console.log('   Testing New RRR Settings: 1:2, 1:2.5, 1:3, 1:4, 1:5 | 5% Risk Guard   ');
    console.log('========================================================================\n');

    const testerBase = new BTCBacktester();
    console.log('⏳ Fetching 10-Year Daily BTC Data from Yahoo Finance (2014 - 2026)...');
    const btc10yCandles = await testerBase.fetchCandles('1d', '10y');
    console.log(`✅ Loaded ${btc10yCandles.length} daily bars from ${btc10yCandles[0].dateStr} to ${btc10yCandles[btc10yCandles.length - 1].dateStr}.`);

    // Slicing 5-year data (last ~1826 days)
    const btc5yCandles = btc10yCandles.slice(-1826);
    console.log(`✅ Extracted 5-Year dataset: ${btc5yCandles.length} daily bars from ${btc5yCandles[0].dateStr} to ${btc5yCandles[btc5yCandles.length - 1].dateStr}.`);

    console.log('⏳ Fetching 2-Year Intraday Hourly BTC Data (1-Hour candles)...');
    let btcHourlyCandles = [];
    try {
        btcHourlyCandles = await testerBase.fetchCandles('1h', '730d');
        console.log(`✅ Loaded ${btcHourlyCandles.length} hourly bars from ${btcHourlyCandles[0].dateStr} to ${btcHourlyCandles[btcHourlyCandles.length - 1].dateStr}.`);
    } catch(err) {
        console.warn('⚠️ Hourly intraday fetch error:', err.message);
    }

    const rrrList = [2.0, 2.5, 3.0, 4.0, 5.0];

    console.log('\n========================================================================');
    console.log('               10-YEAR BTC DAILY BACKTEST (ALL RRR RATIOS)              ');
    console.log('========================================================================');
    const results10y = [];
    for (const rrr of rrrList) {
        const tester = new BTCBacktester({ rrr, capitalRiskPct: 0.05, initialCapital: 1000 });
        const res = tester.run(btc10yCandles, `10Y Daily (1:${rrr})`);
        results10y.push(res);
    }

    console.table(results10y.map(r => ({
        'RRR': r.rrr,
        'Trades': r.totalTrades,
        'Win Rate': r.winRate,
        'W / L': `${r.wins}W / ${r.losses}L`,
        'Net Return (R)': r.netR,
        'Profit Factor': r.profitFactor,
        'Max Drawdown': r.maxDrawdownPct,
        'Final Capital ($1k start)': `$${r.finalBalance.toLocaleString()}`,
        'Gain %': r.totalReturnPct
    })));

    console.log('\n========================================================================');
    console.log('               5-YEAR BTC DAILY BACKTEST (ALL RRR RATIOS)               ');
    console.log('========================================================================');
    const results5y = [];
    for (const rrr of rrrList) {
        const tester = new BTCBacktester({ rrr, capitalRiskPct: 0.05, initialCapital: 1000 });
        const res = tester.run(btc5yCandles, `5Y Daily (1:${rrr})`);
        results5y.push(res);
    }

    console.table(results5y.map(r => ({
        'RRR': r.rrr,
        'Trades': r.totalTrades,
        'Win Rate': r.winRate,
        'W / L': `${r.wins}W / ${r.losses}L`,
        'Net Return (R)': r.netR,
        'Profit Factor': r.profitFactor,
        'Max Drawdown': r.maxDrawdownPct,
        'Final Capital ($1k start)': `$${r.finalBalance.toLocaleString()}`,
        'Gain %': r.totalReturnPct
    })));

    let resultsHourly = [];
    if (btcHourlyCandles.length > 0) {
        console.log('\n========================================================================');
        console.log('            2-YEAR BTC INTRADAY HOURLY BACKTEST (ALL RRR RATIOS)        ');
        console.log('========================================================================');
        for (const rrr of rrrList) {
            const tester = new BTCBacktester({ rrr, capitalRiskPct: 0.05, initialCapital: 1000 });
            const res = tester.run(btcHourlyCandles, `2Y Hourly (1:${rrr})`);
            resultsHourly.push(res);
        }

        console.table(resultsHourly.map(r => ({
            'RRR': r.rrr,
            'Trades': r.totalTrades,
            'Win Rate': r.winRate,
            'W / L': `${r.wins}W / ${r.losses}L`,
            'Net Return (R)': r.netR,
            'Profit Factor': r.profitFactor,
            'Max Drawdown': r.maxDrawdownPct,
            'Final Capital ($1k start)': `$${r.finalBalance.toLocaleString()}`,
            'Gain %': r.totalReturnPct
        })));
    }

    return {
        results10y,
        results5y,
        resultsHourly
    };
}

if (require.main === module) {
    runBtcBacktests()
        .then(() => {
            console.log('\n[Backtest] BTC Historical Simulation completed successfully.');
        })
        .catch(err => {
            console.error('[Backtest Error]:', err);
        });
}

module.exports = { BTCBacktester, runBtcBacktests };
