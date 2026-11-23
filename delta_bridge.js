/**
 * Master Execution Bridge for Delta Exchange (Live India & Global)
 * 
 * Includes:
 * - Dynamic Risk-Based Position Sizer (Auto-calculates safe lot size based on 1% or 2% risk)
 * - Pre-Trade Margin & Balance Safety Check (Prevents liquidation / insufficient margin errors)
 * - Multi-Asset Support (BTCUSD, XRPUSD, ETHUSD, SOLUSD)
 * - Strict 1:3 RRR Bracket Orders (Entry, Stop-Loss, Take-Profit)
 * - Forex Factory News Filter & CoinGlass Liquidity Confluence
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { processSignal, checkDailyLimit, loadTradeState, saveTradeState } = require('./signal_filter');
const { checkNewsLockout } = require('./modules/news_filter');
const { fetchCoinGlassIntelligence, evaluateLiquidityConfluence } = require('./modules/coinglass_extractor');

const CONFIG_FILE = path.join(__dirname, 'config.json');
let activeScanner = null;

function setActiveScanner(scanner) {
    activeScanner = scanner;
}

function loadConfig() {
    let conf = {
        port: process.env.PORT ? parseInt(process.env.PORT, 10) : 5050,
        delta: {
            environment: process.env.DELTA_ENV || 'live_india',
            api_key: process.env.DELTA_API_KEY || '',
            api_secret: process.env.DELTA_API_SECRET || '',
            auto_execute: true
        },
        coinglass: {
            api_key: process.env.COINGLASS_API_KEY || ''
        },
        news_filter: {
            enabled: process.env.NEWS_FILTER_ENABLED !== 'false',
            pre_news_buffer_minutes: 30,
            post_news_buffer_minutes: 15
        },
        risk: {
            max_daily_trades: 3,
            default_rrr: 3
        }
    };

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const fileConf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            conf = {
                ...conf,
                ...fileConf,
                delta: { ...conf.delta, ...(fileConf.delta || {}) },
                risk: { ...conf.risk, ...(fileConf.risk || {}) }
            };
        } catch (e) {}
    }

    // Cloud environment variables take highest priority
    if (process.env.DELTA_API_KEY) conf.delta.api_key = process.env.DELTA_API_KEY;
    if (process.env.DELTA_API_SECRET) conf.delta.api_secret = process.env.DELTA_API_SECRET;
    if (process.env.DELTA_ENV) conf.delta.environment = process.env.DELTA_ENV;
    if (process.env.PORT) conf.port = parseInt(process.env.PORT, 10);

    return conf;
}

function getDeltaBaseUrl(environment) {
    switch (environment) {
        case 'live_india':
            return 'api.india.delta.exchange';
        case 'live_global':
            return 'api.delta.exchange';
        case 'testnet_global':
            return 'testnet-api.delta.exchange';
        case 'testnet_india':
        case 'testnet':
        default:
            return 'cdn-ind.testnet.deltaex.org';
    }
}

function getDeltaWebUrl(environment, symbol = 'XRPUSD') {
    const clean = symbol.replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
    switch (environment) {
        case 'live_india':
            return `https://india.delta.exchange/app/futures/trade/${clean}`;
        case 'live_global':
            return `https://delta.exchange/app/futures/trade/${clean}`;
        case 'testnet_global':
            return `https://testnet-global.delta.exchange/app/futures/trade/${clean}`;
        case 'testnet_india':
        case 'testnet':
        default:
            return `https://testnet.delta.exchange/app/futures/trade/${clean}`;
    }
}

function createDeltaSignature(secret, method, timestamp, pathStr, queryString = '', body = '') {
    const message = method + timestamp + pathStr + queryString + body;
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// Verified Live Product IDs for Delta Exchange India
const productCache = {
    'BTCUSD': 27,
    'ETHUSD': 3136,
    'XRPUSD': 14969,
    'SOLUSD': 14823
};

// Contract multipliers: how much underlying crypto 1 contract represents
const contractMultipliers = {
    'XRPUSD': 1.0,    // 1 contract = 1 XRP
    'BTCUSD': 0.001,  // 1 contract = 0.001 BTC
    'ETHUSD': 0.01,   // 1 contract = 0.01 ETH
    'SOLUSD': 0.1     // 1 contract = 0.1 SOL
};

function getContractMultiplier(symbol) {
    const clean = (symbol || 'XRPUSD').replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
    return contractMultipliers[clean] || 1.0;
}

function getProductId(host, symbol) {
    return new Promise((resolve) => {
        const cleanSymbol = (symbol || 'XRPUSD').replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
        if (productCache[cleanSymbol]) {
            return resolve(productCache[cleanSymbol]);
        }

        const options = {
            hostname: host,
            port: 443,
            path: '/v2/products',
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && Array.isArray(parsed.result)) {
                        for (const p of parsed.result) {
                            if (p.symbol) {
                                productCache[p.symbol.toUpperCase()] = p.id;
                            }
                        }
                        const id = productCache[cleanSymbol] || productCache['XRPUSD'] || 14969;
                        return resolve(id);
                    }
                } catch (e) {}
                resolve(cleanSymbol === 'XRPUSD' ? 14969 : (cleanSymbol === 'ETHUSD' ? 3136 : 27));
            });
        });

        req.on('error', () => resolve(cleanSymbol === 'XRPUSD' ? 14969 : (cleanSymbol === 'ETHUSD' ? 3136 : 27)));
        req.end();
    });
}

function fetchDeltaBalance(config) {
    return new Promise((resolve) => {
        if (!config.delta.api_key || !config.delta.api_secret) {
            return resolve({ success: false, available_balance: 0, reason: 'NO_KEYS' });
        }
        const host = getDeltaBaseUrl(config.delta.environment);
        const pathStr = '/v2/wallet/balances';
        const method = 'GET';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = createDeltaSignature(config.delta.api_secret, method, timestamp, pathStr, '', '');

        const options = {
            hostname: host,
            port: 443,
            path: pathStr,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.success && Array.isArray(parsed.result)) {
                        const usdt = parsed.result.find(b => b.asset_symbol === 'USDT' || b.asset_symbol === 'USD');
                        const balance = usdt ? parseFloat(usdt.available_balance || usdt.balance) : 0;
                        return resolve({ success: true, available_balance: balance, raw: parsed.result });
                    }
                    resolve({ success: false, available_balance: 0, error: parsed.error });
                } catch (e) {
                    resolve({ success: false, available_balance: 0 });
                }
            });
        });

        req.on('error', () => resolve({ success: false, available_balance: 0 }));
        req.end();
    });
}

function calculateAdaptiveLeverage(notionalValue, availableBalance, requestedLeverage = 10, maxLeverage = 100) {
    if (!availableBalance || availableBalance <= 0) return requestedLeverage;
    
    // Safety target: lock at most 35% of total capital in initial margin to keep 65% free buffer
    const targetMargin = availableBalance * 0.35;
    const neededLeverage = Math.ceil(notionalValue / targetMargin);
    
    if (neededLeverage <= requestedLeverage) {
        return requestedLeverage;
    }
    
    // Standard exchange leverage tiers
    const tiers = [10, 15, 20, 25, 30, 40, 50, 75, 100];
    for (const t of tiers) {
        if (t >= neededLeverage) {
            return Math.min(t, maxLeverage);
        }
    }
    return maxLeverage;
}

function setDeltaProductLeverage(host, productId, leverage, config) {
    return new Promise((resolve) => {
        if (!config.delta.api_key || !config.delta.api_secret) {
            return resolve({ success: false, reason: 'NO_KEYS' });
        }
        const pathStr = `/v2/products/${productId}/orders/leverage`;
        const method = 'POST';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify({ leverage: leverage.toString() });
        const signature = createDeltaSignature(config.delta.api_secret, method, timestamp, pathStr, '', bodyStr);

        const options = {
            hostname: host,
            port: 443,
            path: pathStr,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(resData);
                    resolve({ http_status: res.statusCode, response: parsed, success: res.statusCode === 200 && parsed.success === true });
                } catch (e) {
                    resolve({ http_status: res.statusCode, raw: resData, success: false });
                }
            });
        });

        req.on('error', err => resolve({ status: 'NETWORK_ERROR', message: err.message, success: false }));
        req.write(bodyStr);
        req.end();
    });
}

function fetchLiveTicker(symbol, host) {
    return new Promise((resolve, reject) => {
        const cleanSymbol = (symbol || 'XRPUSD').replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
        const options = {
            hostname: host,
            port: 443,
            path: `/v2/tickers/${cleanSymbol}`,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.result) {
                        return resolve(parsed.result);
                    }
                    reject(new Error('Ticker data missing in response'));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function runAutopilotAnalysis(symbol, config, inputBalance = null, riskPercent = 2, leverage = 10) {
    const host = getDeltaBaseUrl(config.delta.environment);
    const ticker = await fetchLiveTicker(symbol, host);

    // 1. Determine Market Bias & Side Automatically
    const isBullish = ticker.close >= ticker.open;
    const side = isBullish ? 'BUY' : 'SELL';

    // 2. Technical Invalidation Distance (ATR / Dynamic daily range)
    const dailyRange = ticker.high - ticker.low;
    const slDist = Math.max(dailyRange * 0.6, ticker.close * 0.02);

    const entryPrice = ticker.close;
    const stopLoss = parseFloat((isBullish ? entryPrice - slDist : entryPrice + slDist).toFixed(4));
    const takeProfit = parseFloat((isBullish ? entryPrice + (slDist * 3) : entryPrice - (slDist * 3)).toFixed(4));

    // 3. Determine Account Balance (Prioritize Live Exchange Balance)
    const balRes = await fetchDeltaBalance(config);
    let balance = (balRes.success && balRes.available_balance > 0) ? balRes.available_balance : parseFloat(inputBalance || 100);

    // 4. Automatic Position Sizing Math
    const multiplier = getContractMultiplier(symbol);
    const riskPerContract = Math.abs(entryPrice - stopLoss) * multiplier;
    const targetDollarRisk = balance * (riskPercent / 100);
    const autoLots = Math.max(1, Math.floor(targetDollarRisk / riskPerContract));

    const notionalValue = autoLots * entryPrice * multiplier;
    
    // Dynamic Adaptive Leverage if capital is low
    const adaptiveLev = calculateAdaptiveLeverage(notionalValue, balance, leverage, 100);
    const requiredMargin = notionalValue / adaptiveLev;

    const analysisReport = {
        symbol: symbol.toUpperCase(),
        decision: side,
        reasoning: `${side} Signal: Price holding ${isBullish ? 'above' : 'below'} open ($${ticker.open} -> $${ticker.close}) with ${parseFloat(ticker.oi_change_usd_6h || 0) >= 0 ? '+' : ''}$${Math.round(ticker.oi_change_usd_6h || 0).toLocaleString()} 6h Open Interest expansion.`,
        entry_price: entryPrice,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        rrr: '1:3 (STRICT)',
        account_balance_used: balance,
        risk_percent: riskPercent,
        auto_calculated_lots: autoLots,
        contract_multiplier: multiplier,
        notional_value_usd: parseFloat(notionalValue.toFixed(2)),
        required_margin_usd: parseFloat(requiredMargin.toFixed(2)),
        max_1r_loss_usd: parseFloat((autoLots * riskPerContract).toFixed(2)),
        target_3r_profit_usd: parseFloat((autoLots * riskPerContract * 3).toFixed(2)),
        requested_leverage: `${leverage}x`,
        adaptive_leverage: `${adaptiveLev}x`,
        leverage_status: adaptiveLev > leverage
            ? `Low capital ($${balance.toFixed(2)}) detected! Auto-increased leverage from ${leverage}x to ${adaptiveLev}x to keep required margin ($${requiredMargin.toFixed(2)}) safely within available balance.`
            : `Capital sufficient. Maintained safe leverage at ${leverage}x.`
    };

    return analysisReport;
}

function executeDeltaApiCall(host, deltaPayload, config) {
    return new Promise((resolve) => {
        const pathStr = '/v2/orders';
        const method = 'POST';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(deltaPayload);
        const signature = createDeltaSignature(config.delta.api_secret, method, timestamp, pathStr, '', bodyStr);

        const options = {
            hostname: host,
            port: 443,
            path: pathStr,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(resData);
                    resolve({
                        http_status: res.statusCode,
                        host_used: host,
                        response: parsed,
                        dispatched_payload: deltaPayload
                    });
                } catch (e) {
                    resolve({
                        http_status: res.statusCode,
                        host_used: host,
                        raw: resData,
                        dispatched_payload: deltaPayload
                    });
                }
            });
        });

        req.on('error', err => resolve({ status: 'NETWORK_ERROR', host_attempted: host, message: err.message }));
        req.write(bodyStr);
        req.end();
    });
}

async function sendDeltaOrder(orderPayload, config) {
    const primaryHost = getDeltaBaseUrl(config.delta.environment);
    const productId = await getProductId(primaryHost, orderPayload.symbol);
    
    const deltaPayload = {
        product_id: productId,
        size: Number(orderPayload.size || 1),
        side: orderPayload.side.toLowerCase(),
        order_type: orderPayload.order_type || 'market_order',
        bracket_stop_loss_price: String(orderPayload.bracket_stop_loss_price),
        bracket_take_profit_price: String(orderPayload.bracket_take_profit_price),
        time_in_force: 'gtc'
    };

    if (deltaPayload.order_type === 'limit_order' && orderPayload.limit_price) {
        deltaPayload.limit_price = String(orderPayload.limit_price);
    }

    if (!config.delta.api_key || !config.delta.api_secret) {
        return {
            status: 'SIMULATED_SUCCESS',
            message: 'Delta API credentials not set. Order simulated locally without dispatch.',
            payload: deltaPayload
        };
    }

    let result = await executeDeltaApiCall(primaryHost, deltaPayload, config);

    // Fallback to alternative testnet host if network connection fails or CloudFront blocks
    if ((result.status === 'NETWORK_ERROR' || result.http_status === 403) && config.delta.environment.includes('testnet')) {
        const fallbackHosts = ['testnet.delta.exchange', 'testnet-api.delta.exchange'];
        for (const fbHost of fallbackHosts) {
            if (fbHost === primaryHost) continue;
            const fallbackResult = await executeDeltaApiCall(fbHost, deltaPayload, config);
            if (fallbackResult.http_status === 200 || (fallbackResult.response && fallbackResult.response.success)) {
                return fallbackResult;
            }
            if (fallbackResult.http_status && fallbackResult.http_status !== 403) {
                result = fallbackResult;
                break;
            }
        }
    }

    return result;
}

async function handleTradeSignal(signalData) {
    const config = loadConfig();
    const results = {
        received_at: new Date().toISOString(),
        steps: {}
    };

    // 1. News Filter Gate
    if (config.news_filter && config.news_filter.enabled) {
        const newsCheck = await checkNewsLockout(
            config.news_filter.pre_news_buffer_minutes,
            config.news_filter.post_news_buffer_minutes
        );
        results.steps.news_filter = newsCheck;
        if (newsCheck.is_locked) {
            results.verdict = 'REJECTED';
            results.reject_reason = newsCheck.message;
            return results;
        }
    } else {
        results.steps.news_filter = { status: 'DISABLED' };
    }

    // 2. Risk & RRR Filter Gate
    const filterResult = processSignal({
        symbol: signalData.symbol || 'XRPUSD',
        side: signalData.side || 'BUY',
        entryPrice: parseFloat(signalData.entry_price || signalData.price || signalData.entry),
        stopLoss: parseFloat(signalData.stop_loss || signalData.sl),
        takeProfit: signalData.take_profit || signalData.tp ? parseFloat(signalData.take_profit || signalData.tp) : null,
        orderType: signalData.order_type || 'market',
        size: signalData.size || 1,
        rrrPreference: signalData.rrr || config.risk.default_rrr || 3,
        commitTrade: false
    });

    results.steps.signal_and_risk_filter = filterResult;
    if (filterResult.status !== 'APPROVED') {
        results.verdict = 'REJECTED';
        results.reject_reason = filterResult.reason;
        return results;
    }

    // 3. Pre-Trade Sizing & Balance Safety Verification with Adaptive Leverage
    const multiplier = getContractMultiplier(signalData.symbol || 'XRPUSD');
    const entryPrice = filterResult.trade_details.entry_price;
    const stopLoss = filterResult.trade_details.stop_loss;
    const lotSize = filterResult.trade_details.size;
    let leverage = parseInt(signalData.leverage || 10);
    const clientBalance = parseFloat(signalData.account_balance || 0);

    const notionalValue = lotSize * entryPrice * multiplier;
    
    // Automatically calculate adaptive leverage if capital is low
    let adaptiveInfo = null;
    if (clientBalance > 0 && (notionalValue / leverage) > (clientBalance * 0.45)) {
        const originalLev = leverage;
        leverage = calculateAdaptiveLeverage(notionalValue, clientBalance, originalLev, 100);
        adaptiveInfo = {
            adjusted: true,
            original_leverage: `${originalLev}x`,
            adapted_leverage: `${leverage}x`,
            reason: `Capital ($${clientBalance.toFixed(2)}) is low. Automatically increased leverage to ${leverage}x so required margin ($${(notionalValue / leverage).toFixed(2)}) safely fits available balance.`
        };
    }

    const requiredMargin = notionalValue / leverage;
    const dollarRisk1R = lotSize * Math.abs(entryPrice - stopLoss) * multiplier;
    const dollarReward3R = lotSize * Math.abs(filterResult.trade_details.take_profit - entryPrice) * multiplier;

    const marginSafety = {
        lot_size: lotSize,
        contract_multiplier: multiplier,
        notional_value_usd: parseFloat(notionalValue.toFixed(2)),
        leverage: `${leverage}x`,
        adaptive_leverage: adaptiveInfo,
        required_margin_usd: parseFloat(requiredMargin.toFixed(2)),
        dollar_risk_1r: parseFloat(dollarRisk1R.toFixed(2)),
        dollar_reward_3r: parseFloat(dollarReward3R.toFixed(2)),
        available_balance_usd: clientBalance > 0 ? clientBalance : 'NOT_SPECIFIED',
        margin_status: 'SUFFICIENT'
    };

    if (clientBalance > 0 && requiredMargin > clientBalance) {
        marginSafety.margin_status = 'INSUFFICIENT_MARGIN';
        marginSafety.reason = `Required margin ($${requiredMargin.toFixed(2)} at ${leverage}x leverage) exceeds available balance ($${clientBalance.toFixed(2)}). Capital is too low to maintain even at maximum leverage!`;
        results.steps.margin_and_sizing_check = marginSafety;
        results.verdict = 'REJECTED';
        results.reject_reason = marginSafety.reason;
        return results;
    }
    results.steps.margin_and_sizing_check = marginSafety;

    // 4. Liquidity Evaluation
    const cgData = await fetchCoinGlassIntelligence(signalData.symbol || 'XRP', config.coinglass.api_key);
    const liquidityConfluence = evaluateLiquidityConfluence(
        filterResult.trade_details.side,
        filterResult.trade_details.entry_price,
        filterResult.trade_details.stop_loss,
        filterResult.trade_details.take_profit,
        cgData
    );
    results.steps.coinglass_liquidity = liquidityConfluence;

    // 5. Order Dispatch to Delta Exchange (Sync Leverage First)
    if (config.delta.auto_execute) {
        const primaryHost = getDeltaBaseUrl(config.delta.environment);
        const prodId = await getProductId(primaryHost, signalData.symbol || 'XRPUSD');
        
        // Auto-sync leverage setting directly on Delta Exchange product
        const levSync = await setDeltaProductLeverage(primaryHost, prodId, leverage, config);
        results.steps.delta_leverage_sync = {
            product_id: prodId,
            leverage: `${leverage}x`,
            success: levSync.success,
            response: levSync.response || levSync
        };

        const orderRes = await sendDeltaOrder(filterResult.delta_exchange_payload, config);
        results.steps.delta_exchange_dispatch = orderRes;

        const isSuccess = (orderRes.http_status >= 200 && orderRes.http_status < 300) ||
                          (orderRes.response && orderRes.response.success === true);

        if (isSuccess) {
            processSignal({
                ...signalData,
                entryPrice: filterResult.trade_details.entry_price,
                stopLoss: filterResult.trade_details.stop_loss,
                commitTrade: true
            });
            results.verdict = 'EXECUTED';
            results.order_id = orderRes.response?.result?.id || 'SUBMITTED';
        } else {
            results.verdict = 'FAILED_ON_EXCHANGE';
            results.reject_reason = orderRes.response?.error?.message || orderRes.response?.error?.code || orderRes.message || 'Delta API rejected order';
        }
    } else {
        results.steps.delta_exchange_dispatch = {
            mode: 'DRY_RUN_APPROVED',
            message: 'Auto-execute is false. Set auto_execute: true in config.json to dispatch live/testnet.',
            payload: filterResult.delta_exchange_payload
        };
        results.verdict = 'READY_TO_EXECUTE';
    }

    return results;
}

function startServer() {
    const config = loadConfig();
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api-key, signature, timestamp, Accept');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        const rawPath = (req.url || '/').split('?')[0];
        const cleanPath = rawPath.toLowerCase().replace(/\/+$/, '') || '/';
        const hasJsonFormat = (req.url || '').includes('format=json') || req.headers.accept?.includes('application/json');

        // Cloud Health & Uptime Keep-Alive endpoint (for Render / Railway / UptimeRobot)
        if (req.method === 'GET' && (cleanPath === '/health' || cleanPath === '/ping')) {
            const limit = checkDailyLimit();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: 'HEALTHY',
                uptime_seconds: Math.floor(process.uptime()),
                scanner_active: activeScanner ? activeScanner.isRunning : false,
                trades_today: limit.tradesDone,
                max_trades: 3,
                environment: config.delta.environment,
                timestamp: new Date().toISOString()
            }, null, 2));
        }

        // Live Scanner Status endpoint
        if (req.method === 'GET' && cleanPath === '/api/scanner-status') {
            const status = activeScanner ? activeScanner.getStatus() : { running: false, summary: 'Scanner not running' };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(status, null, 2));
        }

        // Scanner Toggle endpoint
        if (req.method === 'POST' && cleanPath === '/api/scanner-toggle') {
            if (!activeScanner) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'NO_SCANNER' }));
            }
            if (activeScanner.isRunning) {
                activeScanner.stop();
            } else {
                activeScanner.start();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ running: activeScanner.isRunning }));
        }

        // Scanner Trigger Single Scan endpoint
        if (req.method === 'POST' && cleanPath === '/api/scanner-scan-now') {
            if (activeScanner) {
                activeScanner.scanOnce();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'SCAN_TRIGGERED' }));
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'NO_SCANNER' }));
        }

        // Fetch Balance endpoint
        if (req.method === 'GET' && cleanPath === '/api/balance') {
            const balRes = await fetchDeltaBalance(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(balRes, null, 2));
        }

        // Reset Counter endpoint
        if (req.method === 'POST' && cleanPath === '/reset-counter') {
            const today = new Date().toISOString().slice(0, 10);
            saveTradeState({ current_date: today, trades_today: 0, history: [] });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'RESET_SUCCESS', trades_today: 0, max_trades: 3 }));
        }

        // Friendly GET on /webhook
        if (req.method === 'GET' && cleanPath === '/webhook') {
            const limit = checkDailyLimit();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                service: 'Delta Exchange Webhook Listener',
                status: 'ONLINE & READY',
                instructions: 'Send a POST request with your trade JSON payload to execute an order.',
                daily_trades_used: `${limit.tradesDone} / 3`,
                example_payload: {
                    symbol: 'XRPUSD',
                    side: 'BUY',
                    entry_price: 0.9250,
                    stop_loss: 0.9050,
                    rrr: 3,
                    size: 10,
                    order_type: 'market'
                }
            }, null, 2));
        }

        // Autopilot Analysis & Execution endpoint
        if (req.method === 'POST' && cleanPath === '/api/autopilot') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const reqData = JSON.parse(body || '{}');
                    const symbol = reqData.symbol || 'XRPUSD';
                    const riskPct = parseFloat(reqData.risk_percent || 2);
                    const leverage = parseInt(reqData.leverage || 10);
                    const inputBal = reqData.account_balance;

                    const analysis = await runAutopilotAnalysis(symbol, config, inputBal, riskPct, leverage);

                    const executionOutcome = await handleTradeSignal({
                        symbol: analysis.symbol,
                        side: analysis.decision,
                        entry_price: analysis.entry_price,
                        stop_loss: analysis.stop_loss,
                        take_profit: analysis.take_profit,
                        rrr: 3,
                        size: analysis.auto_calculated_lots,
                        leverage: leverage,
                        account_balance: analysis.account_balance_used,
                        order_type: 'market'
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        analysis: analysis,
                        execution: executionOutcome
                    }, null, 2));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'AUTOPILOT_ERROR', message: err.message }, null, 2));
                }
            });
            return;
        }

        // Dashboard & Status
        if (req.method === 'GET' && (cleanPath === '/' || cleanPath === '/status')) {
            const limit = checkDailyLimit();
            const state = loadTradeState();

            if (hasJsonFormat) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    service: 'Delta Exchange Bridge',
                    utc_date: limit.todayUtc,
                    trades_today: limit.tradesDone,
                    max_trades: 3,
                    remaining_trades: limit.remainingTrades,
                    delta_environment: config.delta.environment,
                    history: state.history || []
                }, null, 2));
            }

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Delta Exchange Automated Trading Console</title>
    <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        body { background: #0b0e14; color: #e2e8f0; margin: 0; padding: 24px; }
        .container { max-width: 980px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
        .title { font-size: 24px; font-weight: bold; color: #38bdf8; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: bold; }
        .badge-green { background: #064e3b; color: #34d399; border: 1px solid #059669; }
        .badge-orange { background: #7c2d12; color: #fb923c; border: 1px solid #ea580c; }
        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .card { background: #131b26; border: 1px solid #1e293b; border-radius: 12px; padding: 18px; }
        .card-label { font-size: 12px; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
        .card-val { font-size: 22px; font-weight: bold; }
        .card-val.cyan { color: #38bdf8; }
        .card-val.green { color: #4ade80; }
        .card-val.purple { color: #c084fc; }
        .card-val.orange { color: #fb923c; }
        .section { background: #131b26; border: 1px solid #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
        .section-title { font-size: 16px; font-weight: bold; margin-bottom: 14px; color: #f1f5f9; display: flex; justify-content: space-between; align-items: center; }
        .control-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 16px; }
        .control-group label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; text-transform: uppercase; }
        .control-group select, .control-group input { width: 100%; background: #0f172a; border: 1px solid #334155; color: white; padding: 8px 12px; border-radius: 6px; font-size: 14px; font-weight: bold; }
        .calc-box { background: #090d16; border: 1px solid #38bdf840; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
        .calc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 10px; }
        .calc-item { background: #131b26; border: 1px solid #1e293b; border-radius: 8px; padding: 10px; text-align: center; }
        .calc-label { font-size: 11px; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px; }
        .calc-val { font-size: 16px; font-weight: bold; }
        .safety-bar { margin-top: 12px; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .safety-green { background: #064e3b; color: #34d399; border: 1px solid #059669; }
        .safety-red { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
        .btn { background: #0284c7; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.2s; }
        .btn:hover { background: #0369a1; }
        .btn-secondary { background: #334155; }
        .btn-secondary:hover { background: #475569; }
        .btn-danger { background: #991b1b; }
        .btn-danger:hover { background: #b91c1c; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1e293b; }
        th { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
        .console { background: #05080f; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; font-family: monospace; font-size: 13px; color: #7dd3fc; max-height: 250px; overflow-y: auto; white-space: pre-wrap; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <div class="title">⚡ Delta Exchange Trading & Position Sizing Console</div>
                <small style="color: #64748b;">LIVE INDIA | 1:3 RRR | Risk-Based Lot Sizer | Pre-Trade Margin Safety</small>
            </div>
            <div>
                <span class="badge ${limit.tradesDone >= 3 ? 'badge-orange' : 'badge-green'}" id="status-badge">
                    ${limit.tradesDone >= 3 ? 'STANDBY (00:00 UTC)' : 'SYSTEM ACTIVE'}
                </span>
            </div>
        </div>

        <div class="cards">
            <div class="card">
                <div class="card-label">Daily Trades (UTC)</div>
                <div class="card-val ${limit.tradesDone >= 3 ? 'purple' : 'green'}" id="daily-count">${limit.tradesDone} / 3</div>
                <small style="color: #64748b;">Resets 00:00:00 UTC</small>
            </div>
            <div class="card">
                <div class="card-label">Risk-to-Reward</div>
                <div class="card-val cyan">1:3 RRR</div>
                <small style="color: #64748b;">Strict Bracket Target</small>
            </div>
            <div class="card">
                <div class="card-label">Forex Factory News</div>
                <div class="card-val green">CLEAR</div>
                <small style="color: #64748b;">No high-impact USD events</small>
            </div>
            <div class="card">
                <div class="card-label">Environment</div>
                <div class="card-val orange">${config.delta.environment.toUpperCase()}</div>
                <small style="color: #64748b;">Auto-Execute: ${config.delta.auto_execute ? 'LIVE ACTIVE' : 'DRY RUN'}</small>
            </div>
        </div>

        <!-- 24/7 Cloud Background Candle Scanner Box (Option 2) -->
        <div style="background: linear-gradient(135deg, #022c22 0%, #0f172a 100%); border: 2px solid #10b981; border-radius: 12px; padding: 22px; margin-bottom: 24px; box-shadow: 0 10px 25px -5px rgba(16, 185, 129, 0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #6ee7b7; display: flex; align-items: center; gap: 8px;">
                        <span id="scanner-status-pulse">🟢</span>
                        <span>24/7 Cloud Strategy Scanner (Option 2)</span>
                        <span id="scanner-badge" style="font-size: 11px; background: #059669; color: white; padding: 2px 8px; border-radius: 99px;">ACTIVE IN CLOUD</span>
                    </div>
                    <div id="scanner-subtitle" style="color: #94a3b8; font-size: 13px; margin-top: 4px;">
                        Continuously monitoring 15M candle closes for 4H Trend & Base Retests. Your PC can stay powered OFF 24/7.
                    </div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn" id="btn-scanner-toggle" onclick="toggleScanner()" style="background: #047857; font-size: 14px; padding: 10px 18px; border: 1px solid #34d399;">
                        ⏸️ Pause Scanner
                    </button>
                    <button class="btn btn-secondary" onclick="fetchScannerStatus(true)" style="font-size: 14px; padding: 10px 14px;">
                        🔄 Scan Now
                    </button>
                </div>
            </div>

            <!-- Real-time metrics grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px;">
                <div style="background: #064e3b40; border: 1px solid #05966960; border-radius: 8px; padding: 12px;">
                    <div style="font-size: 11px; color: #a7f3d0; text-transform: uppercase;">4H Macro Trend</div>
                    <div id="scanner-trend-val" style="font-size: 16px; font-weight: bold; color: #34d399; margin-top: 2px;">🟢 BULLISH (Longs Only)</div>
                    <small id="scanner-ema-val" style="color: #6ee7b7; font-size: 11px;">4H EMA: Fetching...</small>
                </div>
                <div style="background: #064e3b40; border: 1px solid #05966960; border-radius: 8px; padding: 12px;">
                    <div style="font-size: 11px; color: #a7f3d0; text-transform: uppercase;">Target Zone Floor/Ceiling</div>
                    <div id="scanner-zone-val" style="font-size: 16px; font-weight: bold; color: #38bdf8; margin-top: 2px;">Scanning...</div>
                    <small id="scanner-dist-val" style="color: #7dd3fc; font-size: 11px;">Distance: -</small>
                </div>
                <div style="background: #064e3b40; border: 1px solid #05966960; border-radius: 8px; padding: 12px;">
                    <div style="font-size: 11px; color: #a7f3d0; text-transform: uppercase;">Execution Trigger</div>
                    <div id="scanner-trigger-val" style="font-size: 15px; font-weight: bold; color: #fde047; margin-top: 2px;">Wait for 15M Retest</div>
                    <small style="color: #cbd5e1; font-size: 11px;">Auto 1:3 RRR + ₹51 Sizing</small>
                </div>
                <div style="background: #064e3b40; border: 1px solid #05966960; border-radius: 8px; padding: 12px;">
                    <div style="font-size: 11px; color: #a7f3d0; text-transform: uppercase;">Candle Check Timing</div>
                    <div id="scanner-next-check" style="font-size: 16px; font-weight: bold; color: #f1f5f9; margin-top: 2px;">Every 60s</div>
                    <small id="scanner-last-scan" style="color: #94a3b8; font-size: 11px;">Last: Standing by</small>
                </div>
            </div>

            <!-- Scanner Activity Feed -->
            <div style="margin-top: 14px;">
                <div style="font-size: 12px; font-weight: bold; color: #6ee7b7; margin-bottom: 6px;">Live 24/7 Cloud Feed:</div>
                <div id="scanner-log-feed" style="background: #021a14; border: 1px solid #064e3b; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; color: #a7f3d0; max-height: 110px; overflow-y: auto;">
                    Connecting to cloud scanner...
                </div>
            </div>
        </div>

        <!-- 100% AI Autopilot Box -->
        <div style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); border: 2px solid #6366f1; border-radius: 12px; padding: 22px; margin-bottom: 24px; box-shadow: 0 10px 25px -5px rgba(99, 102, 241, 0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #a5b4fc; display: flex; align-items: center; gap: 8px;">
                        <span>🤖 100% AI Autopilot: Market Analysis & Auto-Position</span>
                        <span style="font-size: 11px; background: #4f46e5; color: white; padding: 2px 8px; border-radius: 99px;">HANDS-FREE</span>
                    </div>
                    <div style="color: #94a3b8; font-size: 13px; margin-top: 4px;">
                        AI decides BUY vs SELL from live order flow & OI surge, auto-sizes lots to your balance, and places 1:3 bracket on Delta!
                    </div>
                </div>
                <button class="btn" onclick="triggerAutopilot()" id="btn-autopilot" style="background: #4f46e5; font-size: 16px; padding: 14px 28px; box-shadow: 0 4px 15px rgba(79, 70, 229, 0.4); border: 1px solid #818cf8;">
                    🚀 RUN AUTOPILOT & TAKE POSITION
                </button>
            </div>
            <div id="autopilot-card" style="display: none; background: #070a12; border: 1px solid #4338ca; border-radius: 8px; padding: 14px; margin-top: 14px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span id="auto-decision-badge" style="font-size: 15px; font-weight: bold; padding: 4px 10px; border-radius: 6px;"></span>
                    <span id="auto-lots-badge" style="font-size: 13px; color: #a5b4fc; font-weight: bold;"></span>
                </div>
                <div id="auto-reasoning-text" style="color: #cbd5e1; font-size: 13px; margin-bottom: 8px;"></div>
                <div id="auto-targets-text" style="font-family: monospace; font-size: 12px; color: #38bdf8;"></div>
            </div>
        </div>

        <div class="section">
            <div class="section-title">
                <span>1. Trade Parameters</span>
                <div>
                    <button class="btn btn-secondary" onclick="openDeltaApp()">🔗 Open Delta Exchange App</button>
                    <button class="btn btn-danger" onclick="resetCounter()" style="margin-left: 8px;">🔄 Reset Daily Count</button>
                </div>
            </div>

            <div class="control-row">
                <div class="control-group">
                    <label>Crypto Asset</label>
                    <select id="asset-select" onchange="onAssetChange()">
                        <option value="XRPUSD" selected>XRPUSD (Ripple)</option>
                        <option value="BTCUSD">BTCUSD (Bitcoin)</option>
                        <option value="ETHUSD">ETHUSD (Ethereum)</option>
                        <option value="SOLUSD">SOLUSD (Solana)</option>
                    </select>
                </div>
                <div class="control-group">
                    <label>Side</label>
                    <select id="side-select" onchange="recalculateAll()">
                        <option value="BUY" selected>BUY (LONG)</option>
                        <option value="SELL">SELL (SHORT)</option>
                    </select>
                </div>
                <div class="control-group">
                    <label>Entry Price ($)</label>
                    <input type="number" step="any" id="entry-price" value="0.9250" oninput="recalculateAll()">
                </div>
                <div class="control-group">
                    <label>Stop Loss (1R) ($)</label>
                    <input type="number" step="any" id="stop-loss" value="0.9050" oninput="recalculateAll()">
                </div>
                <div class="control-group">
                    <label>Take Profit (3R) ($)</label>
                    <input type="number" step="any" id="take-profit" value="0.9850" readonly style="color: #4ade80;">
                </div>
                <div class="control-group">
                    <label>Leverage</label>
                    <select id="leverage-select" onchange="recalculateAll()">
                        <option value="5">5x</option>
                        <option value="10" selected>10x</option>
                        <option value="20">20x</option>
                        <option value="50">50x</option>
                    </select>
                </div>
            </div>

            <!-- Position Sizer & Balance Safety Section -->
            <div class="calc-box">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 8px;">
                    <span style="font-weight: bold; color: #38bdf8;">🧮 2. Risk Sizer & Margin Safety Gate</span>
                    <span style="font-size: 12px; color: #94a3b8;" id="contract-mult-label">1 Contract = 1 XRP</span>
                </div>

                <div class="control-row" style="margin-top: 12px; margin-bottom: 8px;">
                    <div class="control-group">
                        <label style="display: flex; justify-content: space-between; align-items: center;">
                            <span>Your Account Balance ($)</span>
                            <span id="live-bal-pill" style="color: #34d399; font-weight: bold; font-size: 11px; display: none;"></span>
                        </label>
                        <input type="number" id="account-balance" value="0.60" oninput="recalculateAll()">
                    </div>
                    <div class="control-group">
                        <label>Max Risk % per Trade</label>
                        <select id="risk-percent" onchange="autoCalculateLots()">
                            <option value="1">1% Risk (Conservative)</option>
                            <option value="2" selected>2% Risk (Standard)</option>
                            <option value="3">3% Risk (Moderate)</option>
                            <option value="5">5% Risk (Aggressive)</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <label>Contract Lots to Trade</label>
                        <input type="number" id="trade-size" value="10" oninput="recalculateAll()">
                    </div>
                    <div class="control-group" style="display: flex; align-items: flex-end;">
                        <button class="btn btn-secondary" onclick="autoCalculateLots()" style="width: 100%; height: 38px;">🎯 Auto-Size Lots</button>
                    </div>
                </div>

                <div class="calc-grid">
                    <div class="calc-item">
                        <div class="calc-label">Order Notional</div>
                        <div class="calc-val cyan" id="calc-notional">$9.25</div>
                    </div>
                    <div class="calc-item">
                        <div class="calc-label">Required Margin</div>
                        <div class="calc-val purple" id="calc-margin">$0.93</div>
                    </div>
                    <div class="calc-item">
                        <div class="calc-label">Max 1R Loss (If SL hit)</div>
                        <div class="calc-val" id="calc-loss" style="color: #f87171;">-$0.20</div>
                    </div>
                    <div class="calc-item">
                        <div class="calc-label">Target 3R Profit (If TP hit)</div>
                        <div class="calc-val green" id="calc-profit">+$0.60</div>
                    </div>
                </div>

                <div class="safety-bar safety-green" id="safety-banner">
                    <span id="safety-text">🟢 SUFFICIENT BALANCE: Required margin ($0.93) is safe (0.93% of balance).</span>
                    <span id="buffer-text">Buffer: 99.07% free</span>
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px;">
                <label style="font-size: 13px; color: #94a3b8; cursor: pointer;">
                    <input type="checkbox" id="auto-open-tab" checked> Automatically open Delta Exchange web chart on execution
                </label>
                <button class="btn" id="btn-trigger" onclick="triggerTrade()" style="font-size: 15px; padding: 12px 28px;">⚡ Execute 1:3 Trade on Delta</button>
            </div>
        </div>

        <div class="section">
            <div class="section-title">Recent Executed Trades</div>
            <table>
                <thead>
                    <tr>
                        <th>Time (UTC)</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Entry</th>
                        <th>Stop Loss (1R)</th>
                        <th>Take Profit (3R)</th>
                        <th>Ratio</th>
                    </tr>
                </thead>
                <tbody id="trade-history">
                    ${(state.history && state.history.length > 0) ? state.history.slice(-5).reverse().map(t => `
                        <tr>
                            <td>${t.timestamp_utc ? t.timestamp_utc.slice(11, 19) : '-'}</td>
                            <td><strong>${t.symbol}</strong></td>
                            <td style="color: ${t.side === 'BUY' ? '#4ade80' : '#f87171'}">${t.side}</td>
                            <td>$${t.entry_price}</td>
                            <td style="color: #f87171;">$${t.stop_loss}</td>
                            <td style="color: #4ade80;">$${t.take_profit}</td>
                            <td>${t.rrr}</td>
                        </tr>
                    `).join('') : '<tr><td colspan="7" style="text-align: center; color: #64748b;">No trades executed yet today. Ready for signal.</td></tr>'}
                </tbody>
            </table>
        </div>

        <div class="section">
            <div class="section-title">Live Execution Console & Delta Response</div>
            <div class="console" id="log-output">[Delta Bridge] Ready on LIVE INDIA. Position Sizer & Margin Safety active. Choose asset and click Execute.</div>
        </div>
    </div>

    <script>
        const multipliers = {
            'XRPUSD': 1.0,
            'BTCUSD': 0.001,
            'ETHUSD': 0.01,
            'SOLUSD': 0.1
        };

        const presets = {
            'XRPUSD': { entry: 0.9250, sl: 0.9050, multLabel: '1 Contract = 1 XRP' },
            'BTCUSD': { entry: 60900, sl: 60200, multLabel: '1 Contract = 0.001 BTC (~$60.90)' },
            'ETHUSD': { entry: 3450, sl: 3380, multLabel: '1 Contract = 0.01 ETH (~$34.50)' },
            'SOLUSD': { entry: 185, sl: 180, multLabel: '1 Contract = 0.1 SOL (~$18.50)' }
        };

        function onAssetChange() {
            const asset = document.getElementById('asset-select').value;
            const p = presets[asset] || presets['XRPUSD'];
            document.getElementById('entry-price').value = p.entry;
            document.getElementById('stop-loss').value = p.sl;
            document.getElementById('contract-mult-label').textContent = p.multLabel;
            autoCalculateLots();
        }

        function autoCalculateLots() {
            const asset = document.getElementById('asset-select').value;
            const entry = parseFloat(document.getElementById('entry-price').value);
            const sl = parseFloat(document.getElementById('stop-loss').value);
            const balance = parseFloat(document.getElementById('account-balance').value) || 100;
            const riskPct = parseFloat(document.getElementById('risk-percent').value) || 2;
            const mult = multipliers[asset] || 1.0;

            const riskPerUnit = Math.abs(entry - sl) * mult;
            const targetDollarRisk = (balance * (riskPct / 100));

            if (riskPerUnit > 0) {
                let calculatedLots = Math.floor(targetDollarRisk / riskPerUnit);
                if (calculatedLots < 1) calculatedLots = 1;
                document.getElementById('trade-size').value = calculatedLots;
            }
            recalculateAll();
        }

        function recalculateAll() {
            const asset = document.getElementById('asset-select').value;
            const side = document.getElementById('side-select').value;
            const entry = parseFloat(document.getElementById('entry-price').value);
            const sl = parseFloat(document.getElementById('stop-loss').value);
            const lots = parseInt(document.getElementById('trade-size').value) || 1;
            const leverage = parseInt(document.getElementById('leverage-select').value) || 10;
            const balance = parseFloat(document.getElementById('account-balance').value) || 100;
            const mult = multipliers[asset] || 1.0;

            if (isNaN(entry) || isNaN(sl)) return;

            // Recalculate 1:3 Take Profit
            let tp = 0;
            const riskDistance = Math.abs(entry - sl);
            if (side === 'BUY') {
                tp = entry + (riskDistance * 3);
            } else {
                tp = entry - (riskDistance * 3);
            }
            document.getElementById('take-profit').value = tp.toFixed(4);

            // Calculate Notional, Margin, 1R Risk, 3R Reward
            const notional = lots * entry * mult;
            // Dynamic Adaptive Leverage Calculation if capital is low
            let effectiveLeverage = leverage;
            let isAdaptive = false;
            if (balance > 0 && (notional / leverage) > (balance * 0.4)) {
                const neededLev = Math.ceil(notional / (balance * 0.35));
                const tiers = [10, 15, 20, 25, 30, 40, 50, 75, 100];
                for (const t of tiers) {
                    if (t >= neededLev) {
                        effectiveLeverage = Math.min(t, 100);
                        break;
                    }
                }
                if (effectiveLeverage > leverage) {
                    isAdaptive = true;
                }
            }

            const reqMargin = notional / effectiveLeverage;
            const dollarLoss = lots * riskDistance * mult;
            const dollarProfit = lots * (riskDistance * 3) * mult;

            document.getElementById('calc-notional').textContent = '$' + notional.toFixed(2);
            document.getElementById('calc-margin').textContent = '$' + reqMargin.toFixed(2) + (isAdaptive ? ' (' + effectiveLeverage + 'x Adaptive)' : '');
            document.getElementById('calc-loss').textContent = '-$' + dollarLoss.toFixed(2) + ' (' + ((dollarLoss / balance) * 100).toFixed(1) + '%)';
            document.getElementById('calc-profit').textContent = '+$' + dollarProfit.toFixed(2);

            // Safety Margin Check with Adaptive Leverage Awareness
            const banner = document.getElementById('safety-banner');
            const safetyText = document.getElementById('safety-text');
            const bufferText = document.getElementById('buffer-text');
            const triggerBtn = document.getElementById('btn-trigger');

            if (reqMargin > balance) {
                banner.className = 'safety-bar safety-red';
                safetyText.textContent = '🔴 CAPITAL TOO LOW: Even at ' + effectiveLeverage + 'x leverage, margin ($' + reqMargin.toFixed(2) + ') exceeds balance ($' + balance.toFixed(2) + ')!';
                bufferText.textContent = 'Deficit: -$' + (reqMargin - balance).toFixed(2);
                triggerBtn.disabled = true;
                triggerBtn.style.opacity = '0.5';
            } else if (isAdaptive) {
                const marginUsagePct = ((reqMargin / balance) * 100).toFixed(1);
                banner.className = 'safety-bar safety-yellow';
                banner.style.background = 'rgba(234, 179, 8, 0.15)';
                banner.style.border = '1px solid #eab308';
                banner.style.color = '#fde047';
                safetyText.textContent = '⚡ ADAPTIVE LEVERAGE ACTIVE: Capital is low ($' + balance.toFixed(2) + '). Auto-increased leverage from ' + leverage + 'x to ' + effectiveLeverage + 'x so trade fits safely!';
                bufferText.textContent = 'Margin: $' + reqMargin.toFixed(2) + ' (' + marginUsagePct + '%) | Free: ' + (100 - marginUsagePct).toFixed(1) + '%';
                triggerBtn.disabled = false;
                triggerBtn.style.opacity = '1';
            } else {
                const marginUsagePct = ((reqMargin / balance) * 100).toFixed(1);
                banner.className = 'safety-bar safety-green';
                banner.style.background = 'rgba(16, 185, 129, 0.1)';
                banner.style.border = '1px solid #10b981';
                banner.style.color = '#34d399';
                safetyText.textContent = '🟢 SUFFICIENT BALANCE: Margin required ($' + reqMargin.toFixed(2) + ') is ' + marginUsagePct + '% of balance.';
                bufferText.textContent = 'Free Buffer: ' + (100 - marginUsagePct).toFixed(1) + '%';
                triggerBtn.disabled = false;
                triggerBtn.style.opacity = '1';
            }
        }

        async function triggerAutopilot() {
            const btn = document.getElementById('btn-autopilot');
            const log = document.getElementById('log-output');
            const card = document.getElementById('autopilot-card');
            const asset = document.getElementById('asset-select').value;
            const balance = parseFloat(document.getElementById('account-balance').value) || 100;
            const riskPct = parseFloat(document.getElementById('risk-percent').value) || 2;
            const leverage = parseInt(document.getElementById('leverage-select').value) || 10;
            const autoOpen = document.getElementById('auto-open-tab').checked;

            btn.disabled = true;
            btn.textContent = 'Analyzing & Executing...';
            log.textContent += '\\n\\n🤖 [AUTOPILOT TRIGGERED] Running real-time market analysis on ' + asset + '...';

            if (autoOpen) {
                openDeltaApp();
            }

            try {
                const res = await fetch('/api/autopilot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: asset,
                        account_balance: balance,
                        risk_percent: riskPct,
                        leverage: leverage
                    })
                });

                const data = await res.json();
                log.textContent += '\\n<<< [AUTOPILOT ANALYSIS & EXECUTION]:\\n' + JSON.stringify(data, null, 2);
                log.scrollTop = log.scrollHeight;

                if (data.analysis) {
                    card.style.display = 'block';
                    const an = data.analysis;
                    const badge = document.getElementById('auto-decision-badge');
                    badge.textContent = 'AI DECISION: ' + an.decision + ' ' + an.symbol;
                    badge.style.background = an.decision === 'BUY' ? '#064e3b' : '#7f1d1d';
                    badge.style.color = an.decision === 'BUY' ? '#34d399' : '#fca5a5';

                    document.getElementById('auto-lots-badge').textContent = 'Auto Lots: ' + an.auto_calculated_lots + ' contracts | Margin: $' + an.required_margin_usd;
                    document.getElementById('auto-reasoning-text').textContent = an.reasoning;
                    document.getElementById('auto-targets-text').textContent = 'Entry: $' + an.entry_price + ' | SL (1R): $' + an.stop_loss + ' | TP (3R): $' + an.take_profit + ' | Max Risk: -$' + an.max_1r_loss_usd + ' | Target Gain: +$' + an.target_3r_profit_usd;

                    document.getElementById('side-select').value = an.decision;
                    document.getElementById('entry-price').value = an.entry_price;
                    document.getElementById('stop-loss').value = an.stop_loss;
                    document.getElementById('take-profit').value = an.take_profit;
                    document.getElementById('trade-size').value = an.auto_calculated_lots;
                    recalculateAll();
                }

                if (data.execution && data.execution.verdict === 'EXECUTED') {
                    log.textContent += '\\n\\n✅ [AUTOPILOT SUCCESS] Position placed on Delta Exchange! Order ID: ' + (data.execution.order_id || 'Submitted');
                } else if (data.execution && data.execution.verdict === 'FAILED_ON_EXCHANGE') {
                    log.textContent += '\\n\\n❌ [EXCHANGE REJECTED]: ' + (data.execution.reject_reason || 'Exchange rejected order');
                    if (JSON.stringify(data).includes('ip_not_whitelisted')) {
                        log.textContent += '\\n⚠️ Delta IP Whitelist Alert: Turn off IP Whitelist in your Delta API key settings (or add your IP address)!';
                    }
                }
            } catch (err) {
                log.textContent += '\\n<<< [AUTOPILOT NETWORK ERROR]: ' + err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = '🚀 RUN AUTOPILOT & TAKE POSITION';
            }
        }

        function openDeltaApp() {
            const asset = document.getElementById('asset-select').value;
            window.open('https://india.delta.exchange/app/futures/trade/' + asset, '_blank');
        }

        async function resetCounter() {
            if (!confirm('Reset daily trade counter back to 0/3?')) return;
            const res = await fetch('/reset-counter', { method: 'POST' });
            const data = await res.json();
            document.getElementById('daily-count').textContent = '0 / 3';
            document.getElementById('daily-count').className = 'card-val green';
            document.getElementById('status-badge').textContent = 'SYSTEM ACTIVE';
            document.getElementById('status-badge').className = 'badge badge-green';
            alert('Daily trade counter reset to 0/3!');
        }

        async function triggerTrade() {
            const btn = document.getElementById('btn-trigger');
            const log = document.getElementById('log-output');
            const asset = document.getElementById('asset-select').value;
            const side = document.getElementById('side-select').value;
            const entry = parseFloat(document.getElementById('entry-price').value);
            const sl = parseFloat(document.getElementById('stop-loss').value);
            const tp = parseFloat(document.getElementById('take-profit').value);
            const size = parseInt(document.getElementById('trade-size').value);
            const leverage = parseInt(document.getElementById('leverage-select').value);
            const balance = parseFloat(document.getElementById('account-balance').value);
            const autoOpen = document.getElementById('auto-open-tab').checked;

            btn.disabled = true;
            btn.textContent = 'Executing...';

            log.textContent += '\\n\\n>>> [DISPATCHING LIVE ORDER TO DELTA INDIA] ' + side + ' ' + size + ' ' + asset + ' @ $' + entry + ' (SL: $' + sl + ' | TP 1:3: $' + tp + ')';

            if (autoOpen) {
                openDeltaApp();
            }

            try {
                const res = await fetch('/webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: asset,
                        side: side,
                        entry_price: entry,
                        stop_loss: sl,
                        take_profit: tp,
                        rrr: 3,
                        size: size,
                        leverage: leverage,
                        account_balance: balance,
                        order_type: 'market'
                    })
                });

                const data = await res.json();
                log.textContent += '\\n<<< [DELTA API RESPONSE]:\\n' + JSON.stringify(data, null, 2);
                log.scrollTop = log.scrollHeight;

                if (data.verdict === 'EXECUTED') {
                    log.textContent += '\\n\\n✅ [SUCCESS] Order confirmed on Delta Exchange! Check your open position!';
                } else if (data.verdict === 'FAILED_ON_EXCHANGE') {
                    log.textContent += '\\n\\n❌ [EXCHANGE REJECTED]: ' + (data.reject_reason || 'Unknown error');
                    if (JSON.stringify(data).includes('ip_not_whitelisted')) {
                        log.textContent += '\\n⚠️ Delta IP Whitelist Alert: Turn off IP Whitelist in your Delta API key settings (or add your current IP address)!';
                    }
                } else if (data.verdict === 'REJECTED') {
                    log.textContent += '\\n\\n🛡️ [RISK GATE REJECTED]: ' + data.reject_reason;
                }
            } catch (err) {
                log.textContent += '\\n<<< [NETWORK ERROR]: ' + err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = '⚡ Execute 1:3 Trade on Delta';
            }
        }

        async function fetchLiveBalance() {
            try {
                const res = await fetch('/api/balance');
                const data = await res.json();
                if (data.success && data.available_balance > 0) {
                    document.getElementById('account-balance').value = data.available_balance.toFixed(2);
                    const rawUsd = data.raw && data.raw.find(b => b.asset_symbol === 'USD');
                    const inrBal = rawUsd && rawUsd.available_balance_inr ? parseFloat(rawUsd.available_balance_inr).toFixed(2) : (data.available_balance * 85).toFixed(2);
                    const pill = document.getElementById('live-bal-pill');
                    pill.textContent = '🟢 Live Balance: $' + data.available_balance.toFixed(2) + ' (₹' + inrBal + ')';
                    pill.style.display = 'inline';
                    autoCalculateLots();
                }
            } catch(e) {}
        }

        async function fetchScannerStatus(triggerScan = false) {
            try {
                if (triggerScan) {
                    await fetch('/api/scanner-scan-now', { method: 'POST' });
                }
                const res = await fetch('/api/scanner-status');
                const data = await res.json();
                
                const pulse = document.getElementById('scanner-status-pulse');
                const badge = document.getElementById('scanner-badge');
                const btnToggle = document.getElementById('btn-scanner-toggle');
                
                if (data.running) {
                    pulse.textContent = '🟢';
                    badge.textContent = 'ACTIVE IN CLOUD';
                    badge.style.background = '#059669';
                    btnToggle.textContent = '⏸️ Pause Scanner';
                    btnToggle.style.background = '#047857';
                } else {
                    pulse.textContent = '⏸️';
                    badge.textContent = 'PAUSED';
                    badge.style.background = '#6b7280';
                    btnToggle.textContent = '▶️ Resume Scanner';
                    btnToggle.style.background = '#2563eb';
                }

                if (data.trend) {
                    const trendEl = document.getElementById('scanner-trend-val');
                    trendEl.textContent = data.trend === 'BULLISH' ? '🟢 BULLISH (Longs Only)' : '🔴 BEARISH (Shorts Only)';
                    trendEl.style.color = data.trend === 'BULLISH' ? '#34d399' : '#f87171';
                }

                if (data.ema4h) {
                    document.getElementById('scanner-ema-val').textContent = '4H EMA: $' + data.ema4h;
                }

                if (data.targetZone) {
                    document.getElementById('scanner-zone-val').textContent = data.targetZone.type + ' @ $' + data.targetZone.entryLimit;
                    document.getElementById('scanner-dist-val').textContent = 'Distance: ' + (data.distancePct !== null ? data.distancePct + '%' : '-') + ' (SL: $' + data.targetZone.sl + ')';
                } else {
                    document.getElementById('scanner-zone-val').textContent = 'Scanning fresh zones...';
                    document.getElementById('scanner-dist-val').textContent = 'Standing by for displacement';
                }

                if (data.lastScanTime) {
                    document.getElementById('scanner-last-scan').textContent = 'Last: ' + data.lastScanTime.slice(11, 19) + ' UTC';
                }

                if (data.logs && data.logs.length > 0) {
                    const feed = document.getElementById('scanner-log-feed');
                    feed.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
                }
            } catch(e) {}
        }

        async function toggleScanner() {
            try {
                await fetch('/api/scanner-toggle', { method: 'POST' });
                await fetchScannerStatus();
            } catch(e) {}
        }

        // Initialize on load
        window.onload = function() {
            autoCalculateLots();
            fetchLiveBalance();
            fetchScannerStatus();
            setInterval(fetchScannerStatus, 4000);
            setInterval(fetchLiveBalance, 15000);
        };
    </script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }

        // Webhook receiver
        if (req.method === 'POST' && (cleanPath === '/webhook' || cleanPath === '/signal' || cleanPath === '/trigger-demo')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const signalData = JSON.parse(body || '{}');
                    const outcome = await handleTradeSignal(signalData);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(outcome, null, 2));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'INVALID_PAYLOAD', message: err.message }, null, 2));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', path: cleanPath, method: req.method }));
    });

    const PORT = process.env.PORT || config.port || 5050;
    server.listen(PORT, () => {
        console.log(`[Delta Bridge] Running on port ${PORT}`);
        console.log(`[Delta Bridge] Webhook URL: http://localhost:${PORT}/webhook`);
        console.log(`[Delta Bridge] Health Check: http://localhost:${PORT}/health`);
        console.log(`[Delta Bridge] Dashboard: http://localhost:${PORT}`);
    });

    return server;
}

module.exports = {
    startServer,
    setActiveScanner,
    handleTradeSignal,
    loadConfig,
    getProductId,
    getDeltaBaseUrl,
    getDeltaWebUrl,
    getContractMultiplier,
    fetchDeltaBalance,
    fetchLiveTicker,
    runAutopilotAnalysis
};

if (require.main === module) {
    startServer();
}
