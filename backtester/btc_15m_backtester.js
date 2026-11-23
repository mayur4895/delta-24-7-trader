/**
 * Bitcoin (BTCUSDT) 15-Minute 1-Year Backtest Engine
 * 
 * Strategy: Naked Break of Structure (BoS) + Fair Value Gap (FVG) Retest
 * - Zero Indicators (Pure Price Action)
 * - Strict 1:3 Risk-Reward Ratio (and 1:2.5 comparison)
 * - 35,040 15-minute candles evaluated
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'btc_15m_1y.json');

function runBTC15MBacktest(options = {}) {
    if (!fs.existsSync(CACHE_FILE)) {
        throw new Error('BTC 15M cache file not found at ' + CACHE_FILE);
    }

    const candles = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    const swingLookback = options.swingLookback || 5;
    const minGapPct = options.minGapPct || 0.0015; // 0.15% gap filter
    const rrr = options.rrr || 3.0;
    const maxTradesPerDay = options.maxTradesPerDay || 3;

    let swingHighs = [];
    let swingLows = [];
    let fvgList = [];
    let trades = [];
    let activeTrade = null;
    let dailyTrades = {};

    for (let i = 15; i < candles.length; i++) {
        const c = candles[i];
        const p1 = candles[i - 1];
        const p2 = candles[i - 2];
        const p3 = candles[i - 3];
        const dateStr = c.dateStr;

        if (!dailyTrades[dateStr]) dailyTrades[dateStr] = 0;

        // Manage active trade
        if (activeTrade) {
            if (activeTrade.side === 'BUY') {
                if (c.low <= activeTrade.sl) {
                    trades.push({ ...activeTrade, exitTime: c.time, result: 'LOSS', pnlR: -1.0 });
                    activeTrade = null;
                } else if (c.high >= activeTrade.tp) {
                    trades.push({ ...activeTrade, exitTime: c.time, result: 'WIN', pnlR: rrr });
                    activeTrade = null;
                }
            } else if (activeTrade.side === 'SELL') {
                if (c.high >= activeTrade.sl) {
                    trades.push({ ...activeTrade, exitTime: c.time, result: 'LOSS', pnlR: -1.0 });
                    activeTrade = null;
                } else if (c.low <= activeTrade.tp) {
                    trades.push({ ...activeTrade, exitTime: c.time, result: 'WIN', pnlR: rrr });
                    activeTrade = null;
                }
            }
        }

        // Swing detection
        const checkIdx = i - 1 - swingLookback;
        if (checkIdx > swingLookback) {
            let isHigh = true, isLow = true;
            for (let j = 1; j <= swingLookback; j++) {
                if (candles[checkIdx].high <= candles[checkIdx - j].high || candles[checkIdx].high <= candles[checkIdx + j].high) isHigh = false;
                if (candles[checkIdx].low >= candles[checkIdx - j].low || candles[checkIdx].low >= candles[checkIdx + j].low) isLow = false;
            }
            if (isHigh) swingHighs.push({ price: candles[checkIdx].high, time: candles[checkIdx].time });
            if (isLow) swingLows.push({ price: candles[checkIdx].low, time: candles[checkIdx].time });
        }

        const recentSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : 0;
        const recentSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : 9999999;

        // Bullish BoS + FVG
        const bGap = p1.low - p3.high;
        if (p1.close > recentSwingHigh && bGap > (p1.close * minGapPct) && p2.close > p2.open) {
            fvgList.push({ type: 'BULLISH', top: p1.low, bottom: p3.high, mitigated: false, dateStr: p1.dateStr });
        }

        // Bearish BoS + FVG
        const sGap = p3.low - p1.high;
        if (p1.close < recentSwingLow && sGap > (p1.close * minGapPct) && p2.close < p2.open) {
            fvgList.push({ type: 'BEARISH', top: p3.low, bottom: p1.high, mitigated: false, dateStr: p1.dateStr });
        }

        // Entry on retest
        if (!activeTrade && dailyTrades[dateStr] < maxTradesPerDay) {
            for (let z = fvgList.length - 1; z >= Math.max(0, fvgList.length - 15); z--) {
                const fvg = fvgList[z];
                if (fvg.mitigated || fvg.type !== 'BULLISH') continue;
                if (c.low < fvg.bottom - (fvg.top - fvg.bottom)) { fvg.mitigated = true; continue; }
                if (c.low <= fvg.top && c.high >= fvg.top) {
                    fvg.mitigated = true;
                    const entry = fvg.top;
                    const sl = fvg.bottom - (entry * 0.001);
                    const risk = entry - sl;
                    if (risk > 0 && (risk / entry) <= 0.015) {
                        activeTrade = { tradeNum: trades.length + 1, side: 'BUY', dateStr, entry, sl, tp: entry + (risk * rrr), rrr: '1:' + rrr };
                        dailyTrades[dateStr]++;
                        break;
                    }
                }
            }

            if (!activeTrade) {
                for (let z = fvgList.length - 1; z >= Math.max(0, fvgList.length - 15); z--) {
                    const fvg = fvgList[z];
                    if (fvg.mitigated || fvg.type !== 'BEARISH') continue;
                    if (c.high > fvg.top + (fvg.top - fvg.bottom)) { fvg.mitigated = true; continue; }
                    if (c.high >= fvg.bottom && c.low <= fvg.bottom) {
                        fvg.mitigated = true;
                        const entry = fvg.bottom;
                        const sl = fvg.top + (entry * 0.001);
                        const risk = sl - entry;
                        if (risk > 0 && (risk / entry) <= 0.015) {
                            activeTrade = { tradeNum: trades.length + 1, side: 'SELL', dateStr, entry, sl, tp: entry - (risk * rrr), rrr: '1:' + rrr };
                            dailyTrades[dateStr]++;
                            break;
                        }
                    }
                }
            }
        }
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.result === 'WIN').length;
    const losses = trades.filter(t => t.result === 'LOSS').length;
    const winRate = ((wins / totalTrades) * 100).toFixed(1);
    const grossProfitR = wins * rrr;
    const grossLossR = losses * 1.0;
    const netGainR = grossProfitR - grossLossR;
    const profitFactor = (grossProfitR / (grossLossR || 1)).toFixed(2);

    return {
        candlesCount: candles.length,
        dateRange: `${candles[0].dateStr} to ${candles[candles.length - 1].dateStr}`,
        totalTrades, wins, losses, winRate: winRate + '%',
        grossProfitR: '+' + grossProfitR.toFixed(1) + 'R',
        grossLossR: '-' + grossLossR.toFixed(1) + 'R',
        netGainR: '+' + netGainR.toFixed(1) + 'R',
        profitFactor
    };
}

module.exports = { runBTC15MBacktest };

if (require.main === module) {
    const res = runBTC15MBacktest();
    console.log(JSON.stringify(res, null, 2));
}
