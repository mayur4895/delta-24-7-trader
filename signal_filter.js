/**
 * Delta Exchange Signal Filter & Execution Strategist (Node.js)
 * 
 * Strict constraints:
 * 1. DAILY TRADE LIMIT: Max 3 trades per calendar day (UTC 00:00 - 23:59:59).
 * 2. RISK-TO-REWARD RATIO: Fixed 1:2 or 1:3 (default 1:3). Mandatory Stop-Loss.
 * 3. DELTA EXCHANGE COMPATIBILITY: Output clean bracket order webhook & REST payloads.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'daily_trades.json');
const MAX_DAILY_TRADES = 3;
const DEFAULT_RRR = 3; // 1:3

function getCurrentUtcDate() {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getCurrentUtcTimestamp() {
    return new Date().toISOString();
}

function loadTradeState() {
    const today = getCurrentUtcDate();
    if (!fs.existsSync(STATE_FILE)) {
        return { current_date: today, trades_today: 0, history: [] };
    }
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const state = JSON.parse(raw);
        if (state.current_date !== today) {
            const newState = { current_date: today, trades_today: 0, history: [] };
            saveTradeState(newState);
            return newState;
        }
        return state;
    } catch (err) {
        return { current_date: today, trades_today: 0, history: [] };
    }
}

function saveTradeState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function checkDailyLimit() {
    const state = loadTradeState();
    const today = getCurrentUtcDate();
    const tradesDone = state.trades_today || 0;
    const canTrade = tradesDone < MAX_DAILY_TRADES;
    return {
        canTrade,
        tradesDone,
        remainingTrades: Math.max(0, MAX_DAILY_TRADES - tradesDone),
        todayUtc: today
    };
}

function calculateBracketTargets(side, entryPrice, stopLoss, rrrMultiplier = DEFAULT_RRR) {
    const sideNorm = side.toUpperCase();
    if (rrrMultiplier !== 2 && rrrMultiplier !== 3) {
        rrrMultiplier = DEFAULT_RRR;
    }

    let riskDist = 0;
    let takeProfit = 0;

    if (sideNorm === 'BUY' || sideNorm === 'LONG') {
        if (stopLoss >= entryPrice) {
            throw new Error(`For LONG/BUY, Stop-Loss (${stopLoss}) must be strictly BELOW Entry Price (${entryPrice}).`);
        }
        riskDist = parseFloat((entryPrice - stopLoss).toFixed(4));
        takeProfit = parseFloat((entryPrice + (riskDist * rrrMultiplier)).toFixed(4));
    } else if (sideNorm === 'SELL' || sideNorm === 'SHORT') {
        if (stopLoss <= entryPrice) {
            throw new Error(`For SHORT/SELL, Stop-Loss (${stopLoss}) must be strictly ABOVE Entry Price (${entryPrice}).`);
        }
        riskDist = parseFloat((stopLoss - entryPrice).toFixed(4));
        takeProfit = parseFloat((entryPrice - (riskDist * rrrMultiplier)).toFixed(4));
    } else {
        throw new Error(`Invalid side '${side}'. Must be BUY/LONG or SELL/SHORT.`);
    }

    return {
        riskDist,
        takeProfit,
        rrr: rrrMultiplier
    };
}

function generateDeltaPayload(symbol, side, orderType, entryPrice, stopLoss, takeProfit, size = 1) {
    const action = (side.toUpperCase() === 'BUY' || side.toUpperCase() === 'LONG') ? 'buy' : 'sell';
    const isMarket = orderType.toUpperCase().includes('MARKET');

    const payload = {
        symbol: symbol.toUpperCase(),
        side: action,
        order_type: isMarket ? 'market_order' : 'limit_order',
        size: Number(size),
        bracket_stop_loss_price: String(stopLoss),
        bracket_take_profit_price: String(takeProfit),
        time_in_force: 'gtc'
    };

    if (!isMarket) {
        payload.limit_price = String(entryPrice);
    }

    return payload;
}

function processSignal({
    symbol,
    side,
    entryPrice,
    stopLoss,
    takeProfit = null,
    orderType = 'market',
    size = 1,
    rrrPreference = 3,
    commitTrade = false
}) {
    const utcNow = getCurrentUtcTimestamp();
    const limitInfo = checkDailyLimit();

    // 1. Daily Trade Limit Gate
    if (!limitInfo.canTrade) {
        return {
            status: 'REJECTED',
            reason: `DAILY_LIMIT_EXCEEDED: ${limitInfo.tradesDone}/${MAX_DAILY_TRADES} trades completed for UTC date ${limitInfo.todayUtc}. System in STANDBY until 00:00:00 UTC.`,
            trades_today: limitInfo.tradesDone,
            max_daily_trades: MAX_DAILY_TRADES,
            reset_time_utc: '00:00:00 UTC',
            timestamp_utc: utcNow
        };
    }

    // 2. Mandatory Stop-Loss Gate
    if (stopLoss == null || isNaN(stopLoss) || stopLoss <= 0) {
        return {
            status: 'REJECTED',
            reason: 'MISSING_STOP_LOSS: Every signal must have a strictly defined invalidation / Stop-Loss price.',
            timestamp_utc: utcNow
        };
    }

    // 3. Risk-to-Reward calculation
    let bracket;
    try {
        bracket = calculateBracketTargets(side, entryPrice, stopLoss, rrrPreference);
    } catch (err) {
        return {
            status: 'REJECTED',
            reason: err.message,
            timestamp_utc: utcNow
        };
    }

    let finalTp = bracket.takeProfit;
    let finalRrr = bracket.rrr;

    // If signal provided its own TP, verify it satisfies at least 1:2
    if (takeProfit != null && takeProfit > 0) {
        const rewardDist = Math.abs(takeProfit - entryPrice);
        const actualRrr = parseFloat((rewardDist / bracket.riskDist).toFixed(2));
        if (actualRrr < 2.0) {
            return {
                status: 'REJECTED',
                reason: `RRR_TOO_LOW: Provided TP yields 1:${actualRrr}, but minimum permitted is 1:2 (default 1:3).`,
                timestamp_utc: utcNow
            };
        }
        finalTp = takeProfit;
        finalRrr = actualRrr;
    }

    // 4. Generate Delta Exchange Payload
    const deltaPayload = generateDeltaPayload(
        symbol,
        side,
        orderType,
        entryPrice,
        stopLoss,
        finalTp,
        size
    );

    const tradeRecord = {
        trade_number_today: limitInfo.tradesDone + 1,
        utc_date: limitInfo.todayUtc,
        symbol: symbol.toUpperCase(),
        side: (side.toUpperCase() === 'BUY' || side.toUpperCase() === 'LONG') ? 'BUY' : 'SELL',
        order_type: orderType.toUpperCase(),
        entry_price: entryPrice,
        stop_loss: stopLoss,
        take_profit: finalTp,
        risk_distance_1r: bracket.riskDist,
        rrr: `1:${finalRrr}`,
        size: Number(size),
        timestamp_utc: utcNow
    };

    if (commitTrade) {
        const state = loadTradeState();
        state.trades_today = limitInfo.tradesDone + 1;
        if (!state.history) state.history = [];
        state.history.push(tradeRecord);
        saveTradeState(state);
    }

    return {
        status: 'APPROVED',
        trade_number: limitInfo.tradesDone + 1,
        remaining_trades_today: MAX_DAILY_TRADES - (commitTrade ? limitInfo.tradesDone + 1 : limitInfo.tradesDone),
        trade_details: tradeRecord,
        delta_exchange_payload: deltaPayload,
        timestamp_utc: utcNow
    };
}

module.exports = {
    checkDailyLimit,
    calculateBracketTargets,
    generateDeltaPayload,
    processSignal,
    loadTradeState,
    saveTradeState,
    MAX_DAILY_TRADES,
    DEFAULT_RRR
};

// Self-test if run directly
if (require.main === module) {
    console.log(`=== Delta Exchange Signal Filter Self-Test (UTC: ${getCurrentUtcTimestamp()}) ===`);
    const limit = checkDailyLimit();
    console.log(`Current UTC Date: ${limit.todayUtc} | Trades Today: ${limit.tradesDone}/${MAX_DAILY_TRADES}`);

    const sample = processSignal({
        symbol: 'BTC-PERP',
        side: 'BUY',
        entryPrice: 68000,
        stopLoss: 67200,
        rrrPreference: 3,
        commitTrade: false
    });

    console.log('\n--- Sample Approved Signal ---');
    console.log(JSON.stringify(sample, null, 2));

    const invalidSample = processSignal({
        symbol: 'BTC-PERP',
        side: 'BUY',
        entryPrice: 68000,
        stopLoss: 68500 // Inverted SL
    });
    console.log('\n--- Sample Invalid Signal (Inverted SL) ---');
    console.log(JSON.stringify(invalidSample, null, 2));
}
