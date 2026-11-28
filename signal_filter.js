/**
 * Delta Exchange Signal Filter & Execution Strategist (Node.js)
 * 
 * Strict constraints:
 * 1. DAILY TRADE LIMIT: Unlimited trades per calendar day.
 * 2. RISK-TO-REWARD RATIO: Strictly bounded between 1:2 (min) and 1:4 (max), default 1:3.
 * 3. MAXIMUM SL DISTANCE: Maximum 2.0% price distance from entry to SL (prevents oversized trades).
 * 4. DELTA EXCHANGE COMPATIBILITY: Output clean bracket order webhook & REST payloads.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'daily_trades.json');
const MAX_DAILY_TRADES = Infinity; // Unlimited trades per day
const MIN_RRR = 2.0; // 1:2
const MAX_RRR = 4.0; // 1:4
const DEFAULT_RRR = 3.0; // 1:3
const MAX_RISK_PERCENT = 2.0; // 2.0% max SL distance to keep risk tight

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
    return {
        canTrade: true,
        tradesDone,
        remainingTrades: 'Unlimited',
        todayUtc: today
    };
}

function calculateBracketTargets(side, entryPrice, stopLoss, rrrMultiplier = DEFAULT_RRR) {
    const sideNorm = side.toUpperCase();
    const parsedRrr = parseFloat(rrrMultiplier);
    // Strict RRR bounds: Minimum 1:2, Maximum 1:4 (Default 1:3)
    if (isNaN(parsedRrr) || parsedRrr < MIN_RRR || parsedRrr > MAX_RRR) {
        rrrMultiplier = DEFAULT_RRR;
    } else {
        rrrMultiplier = parsedRrr;
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

    // 1. Mandatory Stop-Loss Gate
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

    // 2. Risk Distance Guard (Prevent oversized SL and massive trades)
    const riskPercent = (bracket.riskDist / entryPrice) * 100;
    if (riskPercent > MAX_RISK_PERCENT) {
        return {
            status: 'REJECTED',
            reason: `EXCESSIVE_RISK_DISTANCE: Stop-Loss distance is ${riskPercent.toFixed(2)}%, exceeding maximum ${MAX_RISK_PERCENT}% limit to keep risk tight.`,
            timestamp_utc: utcNow
        };
    }

    let finalTp = bracket.takeProfit;
    let finalRrr = bracket.rrr;

    // If signal provided its own TP, verify it satisfies 1:2 to 1:4 strict bounds
    if (takeProfit != null && takeProfit > 0) {
        const rewardDist = Math.abs(takeProfit - entryPrice);
        const actualRrr = parseFloat((rewardDist / bracket.riskDist).toFixed(2));
        if (actualRrr < MIN_RRR || actualRrr > MAX_RRR) {
            return {
                status: 'REJECTED',
                reason: `RRR_OUT_OF_BOUNDS: Provided TP yields 1:${actualRrr}, but RRR must be strictly between 1:2 and 1:4 (target 1:3).`,
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
        remaining_trades_today: 'Unlimited',
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
    MIN_RRR,
    MAX_RRR,
    DEFAULT_RRR,
    MAX_RISK_PERCENT
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
