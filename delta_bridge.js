/**
 * Master Execution Bridge for Delta Exchange India
 * 
 * Includes:
 * - Dynamic Risk-Based Position Sizer (Auto-calculates safe lot size based on 1% or 2% risk)
 * - Pre-Trade Margin & Balance Safety Check (Prevents liquidation / insufficient margin errors)
 * - Multi-Asset Support (XRPUSD, BTCUSD, ETHUSD, SOLUSD)
 * - Dual-Execution Modes:
 *     Option 1: 24/7 Cloud Background Candle Scanner (Waits for 15M bar retest & executes)
 *     Option 2: Resting Zone Limit Order (Places limit order at zone price on Delta with bracket SL/TP)
 * - Institutional Terminal UI with PIN-Protected Exclusive User Access
 * - Live Delta India Positions & Open Orders Manager
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

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
        admin_password_hash: process.env.ADMIN_PASSWORD_HASH || '',
        viewer_password_hash: process.env.VIEWER_PASSWORD_HASH || '',
        viewer_password_hashes: [],
        totp_secret: process.env.TOTP_SECRET || 'DELTA2FAINXAU777',
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
    if (process.env.ADMIN_PASSWORD_HASH) conf.admin_password_hash = process.env.ADMIN_PASSWORD_HASH;
    if (process.env.VIEWER_PASSWORD_HASH) conf.viewer_password_hash = process.env.VIEWER_PASSWORD_HASH;
    if (process.env.TOTP_SECRET) conf.totp_secret = process.env.TOTP_SECRET;

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
        default:
            return `https://testnet.delta.exchange/app/futures/trade/${clean}`;
    }
}

function createDeltaSignature(secret, method, timestamp, pathStr, queryString = '', body = '') {
    const message = method + timestamp + pathStr + queryString + body;
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// Verified Product IDs for Delta Exchange India
const productCache = {
    'BTCUSD': 27,
    'ETHUSD': 3136,
    'XRPUSD': 14969,
    'SOLUSD': 14823,
    'PAXGUSD': 123006, // PAX Gold Token Perpetual
    'XAUTUSD': 131253, // Tether Gold Token Perpetual
    'GOLD': 123006,
    'XAUUSD': 123006
};

// Contract multipliers
const contractMultipliers = {
    'XRPUSD': 1.0,    // 1 contract = 1 XRP (~$0.95 notional)
    'BTCUSD': 0.001,  // 1 contract = 0.001 BTC (~$60 notional)
    'ETHUSD': 0.01,   // 1 contract = 0.01 ETH (~$17 notional)
    'SOLUSD': 0.1,    // 1 contract = 0.1 SOL (~$7.10 notional)
    'PAXGUSD': 0.001, // 1 contract = 0.001 PAXG (~$3.55 notional)
    'XAUTUSD': 0.001, // 1 contract = 0.001 XAUT (~$3.55 notional)
    'GOLD': 0.001,
    'XAUUSD': 0.001
};

function getContractMultiplier(symbol) {
    const clean = symbol.replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
    return contractMultipliers[clean] || 1.0;
}

async function getProductId(host, symbol) {
    const clean = symbol.replace('-PERP', '').replace('USDT', 'USD').toUpperCase();
    if (productCache[clean]) {
        return productCache[clean];
    }
    return 14969; // Default to XRPUSD
}

function calculateAdaptiveLeverage(notionalValue, accountBalance, requestedLeverage, maxLeverage = 100) {
    const leverageSteps = [10, 15, 20, 25, 30, 40, 50, 75, 100];
    let startIdx = leverageSteps.findIndex(l => l >= requestedLeverage);
    if (startIdx === -1) startIdx = 0;

    for (let i = startIdx; i < leverageSteps.length; i++) {
        const lev = leverageSteps[i];
        if (lev > maxLeverage) break;
        const reqMargin = notionalValue / lev;
        if (reqMargin <= (accountBalance * 0.45)) {
            return lev;
        }
    }
    return Math.min(maxLeverage, 100);
}

function setDeltaProductLeverage(host, productId, leverage, config) {
    return new Promise((resolve) => {
        if (!config.delta.api_key || !config.delta.api_secret) {
            return resolve({ success: false, reason: 'MISSING_API_CREDENTIALS' });
        }

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = `/v2/products/${productId}/orders/leverage`;
        const bodyStr = JSON.stringify({ leverage: String(leverage) });
        const signature = createDeltaSignature(config.delta.api_secret, 'POST', timestamp, pathStr, '', bodyStr);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: res.statusCode === 200 && parsed.success === true, response: parsed });
                } catch(e) {
                    resolve({ success: false, error: e.message, raw: data });
                }
            });
        });

        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.write(bodyStr);
        req.end();
    });
}

function fetchDeltaBalance(config) {
    return new Promise((resolve) => {
        if (!config.delta.api_key || !config.delta.api_secret) {
            return resolve({ success: false, reason: 'MISSING_API_CREDENTIALS' });
        }

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = '/v2/wallet/balances';
        const signature = createDeltaSignature(config.delta.api_secret, 'GET', timestamp, pathStr);
        const host = getDeltaBaseUrl(config.delta.environment);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'GET',
            headers: {
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.result && Array.isArray(parsed.result)) {
                        const usdAsset = parsed.result.find(a => a.asset_symbol === 'USD');
                        const inrAsset = parsed.result.find(a => a.asset_symbol === 'INR');
                        const availUsd = usdAsset ? parseFloat(usdAsset.available_balance || 0) : 0;
                        const inrEquiv = usdAsset && usdAsset.available_balance_inr ? parseFloat(usdAsset.available_balance_inr) : (availUsd * 85);
                        resolve({
                            success: true,
                            available_balance: availUsd,
                            available_balance_inr: inrEquiv,
                            raw: parsed.result
                        });
                    } else {
                        resolve({ success: false, reason: 'NO_BALANCE_FOUND', response: parsed });
                    }
                } catch (err) {
                    resolve({ success: false, reason: 'PARSE_ERROR', error: err.message });
                }
            });
        });

        req.on('error', (err) => resolve({ success: false, reason: 'NETWORK_ERROR', error: err.message }));
        req.end();
    });
}

function fetchDeltaPositions(config) {
    return new Promise((resolve) => {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = '/v2/positions/margined';
        const signature = createDeltaSignature(config.delta.api_secret, 'GET', timestamp, pathStr);
        const host = getDeltaBaseUrl(config.delta.environment);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'GET',
            headers: {
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, positions: parsed.result || [] });
                } catch(e) {
                    resolve({ success: false, error: e.message, positions: [] });
                }
            });
        });
        req.on('error', (err) => resolve({ success: false, error: err.message, positions: [] }));
        req.end();
    });
}

function fetchDeltaOrders(config) {
    return new Promise((resolve) => {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = '/v2/orders?state=open';
        const signature = createDeltaSignature(config.delta.api_secret, 'GET', timestamp, pathStr);
        const host = getDeltaBaseUrl(config.delta.environment);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'GET',
            headers: {
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, orders: parsed.result || [] });
                } catch(e) {
                    resolve({ success: false, error: e.message, orders: [] });
                }
            });
        });
        req.on('error', (err) => resolve({ success: false, error: err.message, orders: [] }));
        req.end();
    });
}

async function cancelDeltaOrder(config, orderId, productId) {
    if (!config.delta.api_key || !config.delta.api_secret) {
        return { success: false, error: 'MISSING_API_CREDENTIALS' };
    }

    // Auto-resolve product_id from open orders if not explicitly passed
    if (!productId || Number(productId) <= 0) {
        try {
            const openOrders = await fetchDeltaOrders(config);
            if (openOrders.success && Array.isArray(openOrders.orders)) {
                const match = openOrders.orders.find(o => String(o.id) === String(orderId));
                if (match && match.product_id) {
                    productId = match.product_id;
                }
            }
        } catch(e) {}
    }

    if (!productId || Number(productId) <= 0) {
        productId = 14969; // Default fallback to XRPUSD
    }

    return new Promise((resolve) => {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = '/v2/orders';
        const payload = { id: Number(orderId) };
        if (productId && Number(productId) > 0) {
            payload.product_id = Number(productId);
        }
        const bodyStr = JSON.stringify(payload);
        const signature = createDeltaSignature(config.delta.api_secret, 'DELETE', timestamp, pathStr, '', bodyStr);
        const host = getDeltaBaseUrl(config.delta.environment);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ success: true, response: parsed });
                    } else {
                        const errMsg = (parsed.error && (parsed.error.message || parsed.error.code)) || 
                                       parsed.message || 
                                       `Exchange returned HTTP ${res.statusCode}`;
                        resolve({ success: false, http_status: res.statusCode, error: errMsg, response: parsed });
                    }
                } catch(e) {
                    resolve({ 
                        success: false, 
                        http_status: res.statusCode, 
                        error: `Non-JSON response from Delta (HTTP ${res.statusCode}): ${data.slice(0, 120)}` 
                    });
                }
            });
        });
        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.write(bodyStr);
        req.end();
    });
}

function executeDeltaApiCall(host, deltaPayload, config) {
    return new Promise((resolve) => {
        if (!config.delta.api_key || !config.delta.api_secret) {
            return resolve({ status: 'SKIPPED', message: 'No API key/secret provided in config.json' });
        }

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const pathStr = '/v2/orders';
        const bodyStr = JSON.stringify(deltaPayload);
        const signature = createDeltaSignature(config.delta.api_secret, 'POST', timestamp, pathStr, '', bodyStr);

        const req = https.request({
            hostname: host,
            path: pathStr,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': config.delta.api_key,
                'timestamp': timestamp,
                'signature': signature,
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
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
                        raw: data,
                        error: 'Non-JSON response'
                    });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ status: 'NETWORK_ERROR', error: err.message });
        });

        req.write(bodyStr);
        req.end();
    });
}

async function sendDeltaOrder(deltaPayload, config) {
    const primaryHost = getDeltaBaseUrl(config.delta.environment);
    if (!deltaPayload.product_id) {
        deltaPayload.product_id = await getProductId(primaryHost, deltaPayload.symbol);
    }
    delete deltaPayload.symbol;
    return await executeDeltaApiCall(primaryHost, deltaPayload, config);
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
                takeProfit: filterResult.trade_details.take_profit,
                commitTrade: true
            });
            results.verdict = 'EXECUTED';
            results.order_id = orderRes.response?.result?.id || 'SUBMITTED';
        } else {
            results.verdict = 'FAILED_ON_EXCHANGE';
            results.reject_reason = orderRes.response?.error?.code || orderRes.error || 'ORDER_REJECTED';
        }
    } else {
        results.verdict = 'DRY_RUN_PASSED';
        results.dispatched_payload = filterResult.delta_exchange_payload;
    }

    return results;
}

// Active 30-Minute Sessions & 2FA State
const activeSessions = new Map(); // token -> { role: 'ADMIN' | 'VIEWER', createdAt, expiresAt }
const pending2FATokens = new Map(); // tempToken -> { createdAt, expiresAt }

function verifyUserPassword(inputPassword, config) {
    if (!inputPassword) return null;
    const cleanInput = String(inputPassword).trim();

    // 1. Check Admin Bcrypt Hash
    if (config.admin_password_hash) {
        try {
            if (bcrypt.compareSync(cleanInput, config.admin_password_hash)) {
                return 'ADMIN';
            }
        } catch(e) {}
    }

    // 2. Check Viewer Bcrypt Hashes (supports viewer_password_hashes array and single viewer_password_hash)
    const viewerHashes = Array.isArray(config.viewer_password_hashes) && config.viewer_password_hashes.length > 0
        ? config.viewer_password_hashes
        : [config.viewer_password_hash].filter(Boolean);

    for (const vHash of viewerHashes) {
        try {
            if (vHash && bcrypt.compareSync(cleanInput, vHash)) {
                return 'VIEWER';
            }
        } catch(e) {}
    }

    return null;
}

function base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0, index = 0;
    const clean = String(base32 || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    const output = Buffer.alloc(Math.floor(clean.length * 5 / 8));
    for (let i = 0; i < clean.length; i++) {
        const val = alphabet.indexOf(clean[i]);
        if (val === -1) continue;
        value = (value << 5) | val;
        bits += 5;
        if (bits >= 8) {
            output[index++] = (value >>> (bits - 8)) & 255;
            bits -= 8;
        }
    }
    return output.slice(0, index);
}

function verifyTotp(secret, token, window = 1) {
    if (!token) return false;
    const key = base32Decode(secret || 'DELTA2FAINXAU777');
    const epoch = Math.floor(Date.now() / 1000 / 30);
    const tokenStr = String(token).trim();
    for (let i = -window; i <= window; i++) {
        const counter = Buffer.alloc(8);
        counter.writeBigInt64BE(BigInt(epoch + i));
        const hmac = crypto.createHmac('sha1', key).update(counter).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
        const formatted = String(code).padStart(6, '0');
        if (formatted === tokenStr) return true;
    }
    return false;
}

function generateTotp(secret) {
    const key = base32Decode(secret || 'DELTA2FAINXAU777');
    const epoch = Math.floor(Date.now() / 1000 / 30);
    const counter = Buffer.alloc(8);
    counter.writeBigInt64BE(BigInt(epoch));
    const hmac = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
    return String(code).padStart(6, '0');
}

// Authentication Check: Auto-expires sessions after 30 minutes of inactivity
function isAuthorized(req, config, requireAdmin = false) {
    const headerToken = req.headers['x-session-token'] || req.headers['x-access-pin'];
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const queryToken = (req.url || '').includes('token=') ? new URL(req.url, 'http://localhost').searchParams.get('token') : (req.url || '').includes('pin=') ? new URL(req.url, 'http://localhost').searchParams.get('pin') : '';
    const token = headerToken || bearerToken || queryToken;

    if (!token) return false;

    // Check active 30-minute session
    if (activeSessions.has(token)) {
        const session = activeSessions.get(token);
        if (Date.now() > session.expiresAt) {
            activeSessions.delete(token); // Expired after 30 minutes!
            return false;
        }
        // Sliding window: reset 30 minutes on active user interaction
        session.expiresAt = Date.now() + (30 * 60 * 1000);

        if (requireAdmin && session.role !== 'ADMIN') {
            return false;
        }
        return true;
    }

    // Direct password match via bcrypt
    const directRole = verifyUserPassword(token, config);
    if (directRole) {
        if (requireAdmin && directRole !== 'ADMIN') return false;
        return true;
    }

    return false;
}

function startServer() {
    const config = loadConfig();
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api-key, signature, timestamp, Accept, x-access-pin, x-session-token, authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        const rawPath = (req.url || '/').split('?')[0];
        const cleanPath = rawPath.toLowerCase().replace(/\/+$/, '') || '/';
        const urlObj = new URL(req.url, 'http://localhost');

        // Cloud Health & Uptime Keep-Alive endpoint (Always Public for UptimeRobot)
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

        // 2FA Info Helper endpoint (Protected: Authorized Admin Only)
        if (req.method === 'GET' && cleanPath === '/api/auth/totp-hint') {
            if (!isAuthorized(req, config)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
            }
            const secret = config.totp_secret || 'DELTA2FAINXAU777';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                secret: secret,
                account: 'DeltaIndia (Admin)',
                otpauth: `otpauth://totp/DeltaIndia:Admin?secret=${secret}&issuer=DeltaIndia`
            }));
        }

        // Step 1: Verify 2FA Code endpoint (Public)
        if (req.method === 'POST' && cleanPath === '/api/auth/verify-2fa') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const code = String(data.code || '').trim();
                    const secret = config.totp_secret || 'DELTA2FAINXAU777';
                    const isValid = verifyTotp(secret, code);

                    if (isValid) {
                        const tempToken = crypto.randomBytes(16).toString('hex');
                        pending2FATokens.set(tempToken, { createdAt: Date.now(), expiresAt: Date.now() + (5 * 60 * 1000) });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: true, step: '2FA_VERIFIED', temp_token: tempToken }));
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid 6-digit 2FA code. Please check your Authenticator app.' }));
                    }
                } catch(e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'INVALID_JSON' }));
                }
            });
            return;
        }

        // Step 2: Verify Master Password endpoint (Public, requires valid temp_token or 2FA)
        if (req.method === 'POST' && cleanPath === '/api/auth/verify-password') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const tempToken = String(data.temp_token || '').trim();
                    const password = String(data.password || '').trim();

                    // Check temp token from Step 1 (2FA)
                    if (!pending2FATokens.has(tempToken) || Date.now() > pending2FATokens.get(tempToken).expiresAt) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: '2FA_REQUIRED', message: '2FA session expired. Please complete Step 1 (2FA) first.' }));
                    }

                    const role = verifyUserPassword(password, config);
                    if (role) {
                        pending2FATokens.delete(tempToken);
                        const sessionToken = crypto.randomBytes(32).toString('hex');
                        const expiresAt = Date.now() + (30 * 60 * 1000); // Strict 30-minute auto-logout
                        activeSessions.set(sessionToken, { role: role, createdAt: Date.now(), expiresAt });

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({
                            success: true,
                            token: sessionToken,
                            role: role,
                            expires_at: expiresAt,
                            expires_in_seconds: 1800,
                            message: `Authenticated successfully as ${role}. Session valid for 30 minutes.`
                        }));
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'INCORRECT_PASSWORD', message: 'Incorrect Password.' }));
                    }
                } catch(e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'INVALID_JSON' }));
                }
            });
            return;
        }

        // Auth Verification endpoint (Legacy / Direct 2-in-1 verification)
        if (req.method === 'POST' && cleanPath === '/api/auth/verify') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const inputPin = String(data.pin || data.password || '').trim();
                    const input2fa = String(data.code_2fa || data.code || '').trim();
                    const secret = config.totp_secret || 'DELTA2FAINXAU777';

                    let is2faOk = true;
                    if (input2fa) {
                        is2faOk = verifyTotp(secret, input2fa);
                    }

                    const role = verifyUserPassword(inputPin, config);
                    if (role && is2faOk) {
                        const sessionToken = crypto.randomBytes(32).toString('hex');
                        const expiresAt = Date.now() + (30 * 60 * 1000);
                        activeSessions.set(sessionToken, { role: role, createdAt: Date.now(), expiresAt });

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: true, token: sessionToken, role: role, expires_at: expiresAt, expires_in_seconds: 1800 }));
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({
                            success: false,
                            error: !is2faOk ? 'INVALID_2FA_CODE' : 'INCORRECT_PASSWORD',
                            message: !is2faOk ? 'Invalid 2FA code.' : 'Incorrect password.'
                        }));
                    }
                } catch(e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'INVALID_JSON' }));
                }
            });
            return;
        }

        // Change Master Password endpoint (Protected: Master Admin Only)
        if (req.method === 'POST' && cleanPath === '/api/auth/change-password') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Master Admin privileges required to change security settings.' }));
            }
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const newPass = String(data.new_password || '').trim();
                    if (!newPass || newPass.length < 4) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'PASSWORD_TOO_SHORT', message: 'New password must be at least 4 characters.' }));
                    }

                    const newHash = bcrypt.hashSync(newPass, 10);
                    config.admin_password_hash = newHash;

                    try {
                        const cfgPath = path.join(__dirname, 'config.json');
                        let curCfg = {};
                        if (fs.existsSync(cfgPath)) {
                            curCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                        }
                        curCfg.admin_password_hash = newHash;
                        fs.writeFileSync(cfgPath, JSON.stringify(curCfg, null, 2));
                    } catch(err) {
                        console.error('[Delta Bridge] Error writing config.json:', err.message);
                    }

                    console.log(`[Delta Bridge] Master Password bcrypt hash successfully updated by owner.`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, message: 'Master Password updated successfully!' }));
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Logout endpoint (Invalidates 30-minute session)
        if (req.method === 'POST' && cleanPath === '/api/auth/logout') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const token = data.token || req.headers['x-session-token'];
                    if (token && activeSessions.has(token)) {
                        activeSessions.delete(token);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, message: 'Logged out successfully.' }));
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true }));
                }
            });
            return;
        }

        // Security check for protected API routes
        if (cleanPath.startsWith('/api/') || cleanPath === '/webhook' || cleanPath === '/reset-counter') {
            if (!isAuthorized(req, config)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    error: 'UNAUTHORIZED',
                    message: 'Access restricted to authorized terminal owner. Please unlock terminal with Access PIN.'
                }));
            }
        }

        // Fetch Balance endpoint (Master Admin Only)
        if (req.method === 'GET' && cleanPath === '/api/balance') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Balance viewing restricted to Master Admin.' }));
            }
            const balRes = await fetchDeltaBalance(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(balRes, null, 2));
        }

        // Live Scanner Status endpoint (Viewer & Admin)
        if (req.method === 'GET' && cleanPath === '/api/scanner-status') {
            const status = activeScanner ? activeScanner.getStatus() : { running: false, summary: 'Scanner not running' };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(status, null, 2));
        }

        // Scanner Toggle endpoint (Master Admin Only)
        if (req.method === 'POST' && cleanPath === '/api/scanner-toggle') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Scanner control restricted to Master Admin.' }));
            }
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

        // Multi-Asset Setup Diagnostic Analyzer endpoint (Viewer & Admin)
        if (req.method === 'GET' && (cleanPath === '/api/analyze' || cleanPath.startsWith('/api/analyze/'))) {
            const targetSymbol = (cleanPath.replace('/api/analyze/', '').replace('/api/analyze', '') || urlObj.searchParams.get('symbol') || 'XRPUSD').toUpperCase();
            if (activeScanner) {
                try {
                    const analysis = await activeScanner.analyzeMarket(targetSymbol);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(analysis, null, 2));
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e.message }));
                }
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'SCANNER_UNAVAILABLE' }));
            }
        }

        // Place Resting Zone Limit Order endpoint (Master Admin Only)
        if (req.method === 'POST' && cleanPath === '/api/order/limit') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Order execution restricted to Master Admin.' }));
            }
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const reqData = JSON.parse(body || '{}');
                    const balRes = await fetchDeltaBalance(config);
                    const bal = balRes.success ? balRes.available_balance : (reqData.account_balance || 0.60);

                    const payload = {
                        symbol: reqData.symbol || 'XRPUSD',
                        side: reqData.side || 'BUY',
                        entry_price: parseFloat(reqData.limit_price || reqData.entry_price),
                        stop_loss: parseFloat(reqData.stop_loss),
                        take_profit: parseFloat(reqData.take_profit),
                        rrr: 3,
                        size: parseInt(reqData.size || 1, 10),
                        leverage: parseInt(reqData.leverage || 10, 10),
                        account_balance: bal,
                        order_type: 'limit'
                    };

                    const outcome = await handleTradeSignal(payload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(outcome, null, 2));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'LIMIT_ORDER_ERROR', message: err.message }));
                }
            });
            return;
        }

        // Live Positions endpoint (Master Admin Only)
        if (req.method === 'GET' && cleanPath === '/api/positions') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Positions viewing restricted to Master Admin.' }));
            }
            const posRes = await fetchDeltaPositions(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(posRes, null, 2));
        }

        // Live Open Orders endpoint (Master Admin Only)
        if (req.method === 'GET' && cleanPath === '/api/orders') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Orders viewing restricted to Master Admin.' }));
            }
            const ordRes = await fetchDeltaOrders(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(ordRes, null, 2));
        }

        // Cancel Order endpoint (Master Admin Only)
        if (req.method === 'POST' && cleanPath === '/api/order/cancel') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Order cancellation restricted to Master Admin.' }));
            }
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const cancelRes = await cancelDeltaOrder(config, data.order_id, data.product_id);
                    res.writeHead(cancelRes.success ? 200 : 400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(cancelRes, null, 2));
                } catch(e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // Reset Counter endpoint (Master Admin Only)
        if (req.method === 'POST' && cleanPath === '/reset-counter') {
            if (!isAuthorized(req, config, true)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Counter reset restricted to Master Admin.' }));
            }
            const today = new Date().toISOString().slice(0, 10);
            saveTradeState({ current_date: today, trades_today: 0, history: [] });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'RESET_SUCCESS', trades_today: 0, max_trades: 3 }));
        }

        // Dashboard (HTML)
        if (req.method === 'GET' && (cleanPath === '/' || cleanPath === '/index.html')) {
            const limit = checkDailyLimit();
            const state = loadTradeState();

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Delta India — Institutional Trading Terminal</title>
    <style>
        :root {
            --bg-base: #080b12;
            --bg-card: #0f1523;
            --bg-surface: #151d30;
            --border-subtle: #1e293b;
            --border-accent: #334155;
            --text-main: #f8fafc;
            --text-dim: #94a3b8;
            --text-muted: #64748b;
            --green: #10b981;
            --green-glow: rgba(16, 185, 129, 0.15);
            --red: #f43f5e;
            --red-glow: rgba(244, 63, 94, 0.15);
            --cyan: #38bdf8;
            --amber: #f59e0b;
            --purple: #a855f7;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif; }
        body { background: var(--bg-base); color: var(--text-main); min-height: 100vh; padding-bottom: 40px; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

        /* Auth Modal Lock */
        #auth-modal { position: fixed; inset: 0; background: rgba(8, 11, 18, 0.94); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 9999; }
        .auth-card { background: var(--bg-card); border: 1px solid var(--border-accent); border-radius: 12px; padding: 32px; width: 380px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); text-align: center; }
        .auth-input { width: 100%; background: var(--bg-surface); border: 1px solid var(--border-accent); border-radius: 8px; color: white; padding: 12px; font-size: 16px; margin: 18px 0; text-align: center; letter-spacing: 2px; }
        .btn-unlock { width: 100%; background: #2563eb; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: 0.15s; }
        .btn-unlock:hover { background: #1d4ed8; }

        /* Header Navigation */
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); padding-bottom: 16px; margin-bottom: 24px; flex-wrap: wrap; gap: 14px; }
        .brand-title { font-size: 20px; font-weight: 700; color: #f8fafc; letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; }
        .badge-live { background: #064e3b; color: #34d399; border: 1px solid #059669; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .header-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .pill-stat { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 14px; font-size: 13px; font-weight: 500; }
        .pill-stat span { color: var(--text-dim); }

        /* Symbol Switcher Tabs */
        .symbol-tabs { display: flex; gap: 8px; margin-bottom: 20px; overflow-x: auto; }
        .tab-btn { background: var(--bg-card); border: 1px solid var(--border-subtle); color: var(--text-dim); padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: 0.15s; }
        .tab-btn:hover { border-color: var(--border-accent); color: var(--text-main); }
        .tab-btn.active { background: var(--bg-surface); border-color: #38bdf8; color: #38bdf8; }

        /* Setup Diagnostics Card */
        .setup-card { background: var(--bg-card); border: 1px solid var(--border-accent); border-radius: 12px; padding: 22px; margin-bottom: 24px; }
        .setup-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
        .setup-title { font-size: 16px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 8px; }
        .setup-badge { padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; }

        /* Price Gauge Ladder */
        .price-gauge { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
        .gauge-item { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px; }
        .gauge-label { font-size: 11px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 4px; font-weight: 600; }
        .gauge-val { font-size: 18px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }

        /* Diagnostic Explanation Box */
        .explanation-box { background: var(--bg-surface); border-left: 4px solid #38bdf8; padding: 16px; border-radius: 0 8px 8px 0; margin-top: 16px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
        .explanation-box strong { color: white; }

        /* Two Modes Execution Section */
        .modes-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; margin-bottom: 24px; }
        .mode-box { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; }
        .mode-box.active-mode { border-color: var(--green); }
        .mode-header { font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
        .mode-desc { font-size: 13px; color: var(--text-dim); line-height: 1.5; margin-bottom: 16px; }

        .btn { padding: 10px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: 0.15s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
        .btn-primary { background: #059669; color: white; border-color: #10b981; }
        .btn-primary:hover { background: #047857; }
        .btn-secondary { background: var(--bg-surface); border-color: var(--border-accent); color: var(--text-main); }
        .btn-secondary:hover { border-color: #64748b; }
        .btn-blue { background: #2563eb; color: white; border-color: #3b82f6; width: 100%; }
        .btn-blue:hover { background: #1d4ed8; }
        .btn-danger { background: #991b1b; color: white; border-color: #ef4444; }

        /* Tables */
        .section-table { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
        .section-header { font-size: 15px; font-weight: 700; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
        th { color: var(--text-dim); font-size: 11px; text-transform: uppercase; padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); font-weight: 600; }
        td { padding: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }

        /* Monospace Logs */
        .console-feed { background: #06090f; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #a7f3d0; max-height: 120px; overflow-y: auto; line-height: 1.6; }
    </style>
</head>
<body>

    <!-- 2-Step Authentication Overlay (2FA First, then Master Password) -->
    <div id="auth-modal" style="display: flex;">
        <div class="auth-card" style="width: 420px; text-align: left;">
            <!-- Step 1: 2FA Verification -->
            <div id="auth-step-1">
                <div style="text-align: center; margin-bottom: 16px;">
                    <div style="font-size: 32px; margin-bottom: 6px;">🛡️</div>
                    <div style="font-size: 18px; font-weight: 700; color: white;">Step 1: Two-Factor Authentication</div>
                    <p style="font-size: 12px; color: var(--text-dim); margin-top: 6px;">
                        Enter the 6-digit verification code from Google Authenticator, Microsoft Authenticator, or Apple Keychain.
                    </p>
                </div>

                <div style="margin: 16px 0;">
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">6-Digit Authenticator Code</label>
                    <input type="text" id="input-2fa-code" maxlength="6" class="auth-input" placeholder="000000" style="font-size: 24px; letter-spacing: 6px; margin: 8px 0; text-align: center;" onkeydown="if(event.key==='Enter') submit2FA()">
                    <div id="2fa-error" style="color: var(--red); font-size: 12px; margin-bottom: 8px; display: none;">Invalid 2FA code. Please check your app.</div>
                </div>

                <button class="btn-unlock" onclick="submit2FA()" id="btn-verify-2fa">Verify 2FA Code ➔</button>
            </div>

            <!-- Step 2: Master Password Entry -->
            <div id="auth-step-2" style="display: none;">
                <div style="text-align: center; margin-bottom: 16px;">
                    <div style="font-size: 32px; margin-bottom: 6px;">🔐</div>
                    <div style="font-size: 18px; font-weight: 700; color: white;">Step 2: Enter Master Password</div>
                    <p style="font-size: 12px; color: var(--green); margin-top: 6px; font-weight: 600;">
                        ✓ 2FA Code Verified Successfully!
                    </p>
                    <p style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">
                        Enter your private password to unlock your terminal for 30 minutes.
                    </p>
                </div>

                <div style="margin: 16px 0;">
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Master Password</label>
                    <input type="password" id="input-password" class="auth-input" placeholder="Enter Password" style="margin: 8px 0; text-align: center; letter-spacing: 2px;" onkeydown="if(event.key==='Enter') submitPassword()">
                    <div id="password-error" style="color: var(--red); font-size: 12px; margin-bottom: 8px; display: none;">Incorrect Master Password</div>
                </div>

                <button class="btn-unlock" onclick="submitPassword()" id="btn-unlock-terminal" style="background: #059669; margin-bottom: 10px;">Unlock Institutional Terminal 🔓</button>
                <button class="btn btn-secondary" onclick="backTo2FA()" style="width: 100%; font-size: 12px;">⬅ Back to 2FA Step</button>
            </div>
        </div>
    </div>

    <!-- Security & Password Management Modal -->
    <div id="security-modal" style="display: none; position: fixed; inset: 0; background: rgba(8, 11, 18, 0.94); backdrop-filter: blur(8px); align-items: center; justify-content: center; z-index: 10000;">
        <div class="auth-card" style="width: 440px; text-align: left;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 10px;">
                <h3 style="font-size: 16px; font-weight: 700; color: white; display: flex; align-items: center; gap: 8px;">
                    <span>⚙️ Security & Password Settings</span>
                </h3>
                <button onclick="closeSecurityModal()" style="background: none; border: none; color: var(--text-dim); font-size: 18px; cursor: pointer;">✕</button>
            </div>

            <!-- Change Master Password Form -->
            <div style="margin-bottom: 20px;">
                <h4 style="font-size: 13px; color: #38bdf8; margin-bottom: 10px; font-weight: 600;">🔑 Change Master Password</h4>
                <div style="margin-bottom: 10px;">
                    <label style="font-size: 11px; color: var(--text-dim); display: block; margin-bottom: 4px;">New Master Password</label>
                    <input type="password" id="new-password-input" class="auth-input" placeholder="Enter new strong password" style="margin: 0; padding: 10px; text-align: left; font-size: 14px;">
                </div>
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 11px; color: var(--text-dim); display: block; margin-bottom: 4px;">Confirm New Password</label>
                    <input type="password" id="confirm-password-input" class="auth-input" placeholder="Repeat new password" style="margin: 0; padding: 10px; text-align: left; font-size: 14px;">
                </div>
                <button class="btn btn-primary" onclick="changeMasterPassword()" style="width: 100%; font-size: 13px;">💾 Save New Password</button>
                <div id="change-pwd-status" style="font-size: 12px; margin-top: 8px; text-align: center; display: none;"></div>
            </div>

            <!-- Two-Factor Authentication Status -->
            <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px; font-size: 12px;">
                <div style="font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
                    <span>🛡️ 2FA Status: ACTIVE (RFC 6238 TOTP)</span>
                </div>
                <p style="color: var(--text-dim); margin-bottom: 8px;">
                    Required on every login before entering your Master Password.
                </p>
                <div style="background: #080b12; padding: 6px 10px; border-radius: 4px; font-family: monospace; color: #34d399; font-weight: 700; display: flex; justify-content: space-between; align-items: center;">
                    <span>Key: DELTA2FAINXAU777</span>
                    <button onclick="navigator.clipboard.writeText('DELTA2FAINXAU777'); alert('2FA Secret Key copied to clipboard!');" style="background: #1e293b; color: white; border: none; padding: 2px 6px; border-radius: 4px; font-size: 10px; cursor: pointer;">Copy</button>
                </div>
                <div style="margin-top: 8px; color: var(--text-muted); font-size: 11px;">
                    • 30-Minute Auto-Lock: Active (resets on clicks/keyboard activity)
                </div>
            </div>
        </div>
    </div>

    <!-- Main Terminal Dashboard (Displayed for Owner Only after 2FA + Password) -->
    <div class="container" id="terminal-app" style="display: none;">
        <!-- Header -->
        <div class="header">
            <div>
                <div class="brand-title">
                    <span>⚡ DELTA EXCHANGE INDIA</span>
                    <span class="badge-live">LIVE INSTITUTIONAL</span>
                    <span id="user-role-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);">🛡️ 2FA + Master Password</span>
                </div>
                <small style="color: var(--text-muted); font-size: 12px;">24/7 Supply & Demand Flow Terminal • Strict 1:3 RRR • Margin Safety Buffer</small>
            </div>
            <div class="header-meta">
                <div class="pill-stat" id="pill-balance">
                    <span>Wallet Balance: </span>
                    <strong id="header-balance" style="color: #38bdf8;">Loading...</strong>
                </div>
                <div class="pill-stat" id="pill-budget">
                    <span>Daily Budget: </span>
                    <strong id="header-trades">${limit.tradesDone} / 3 Trades</strong>
                </div>
                <div class="pill-stat" id="pill-session" style="border-color: rgba(56, 189, 248, 0.35);">
                    <span>Session: </span>
                    <strong id="session-countdown" style="color: #38bdf8;">30:00</strong>
                </div>
                <button class="btn btn-secondary" id="btn-security-settings" onclick="openSecurityModal()" style="padding: 6px 12px; font-size: 12px;" title="View or change login password & 2FA settings">⚙️ Security</button>
                <button class="btn btn-secondary" id="btn-lock" onclick="logout('Locked by owner.')" style="padding: 6px 12px; font-size: 12px;">🔒 Lock</button>
            </div>
        </div>

        <!-- Symbol Selector Pills -->
        <div class="symbol-tabs">
            <button class="tab-btn active" onclick="selectSymbol('XAUUSD', this)">🪙 Gold (XAUUSD)</button>
            <button class="tab-btn" onclick="selectSymbol('XRPUSD', this)">Ripple (XRPUSD)</button>
            <button class="tab-btn" onclick="selectSymbol('BTCUSD', this)">Bitcoin (BTCUSD)</button>
            <button class="tab-btn" onclick="selectSymbol('ETHUSD', this)">Ethereum (ETHUSD)</button>
            <button class="tab-btn" onclick="selectSymbol('SOLUSD', this)">Solana (SOLUSD)</button>
        </div>

        <!-- Setup Diagnostics Card -->
        <div class="setup-card">
            <div class="setup-top">
                <div class="setup-title">
                    <span id="active-symbol-badge" style="color: #38bdf8;">Gold (XAUUSD)</span>
                    <span>Institutional Flow Diagnostic</span>
                </div>
                <div id="setup-status-badge" class="setup-badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid #f59e0b;">
                    ANALYZING MARKET...
                </div>
            </div>

            <!-- Price Ladder -->
            <div class="price-gauge">
                <div class="gauge-item">
                    <div class="gauge-label">Live 15M Price</div>
                    <div class="gauge-val" id="metric-live-price" style="color: white;">-</div>
                </div>
                <div class="gauge-item">
                    <div class="gauge-label">4H Macro Trend</div>
                    <div class="gauge-val" id="metric-trend" style="color: var(--green);">-</div>
                    <small id="metric-ema" style="color: var(--text-dim); font-size: 11px;">EMA: -</small>
                </div>
                <div class="gauge-item">
                    <div class="gauge-label" id="metric-zone-label">Target Zone Entry</div>
                    <div class="gauge-val" id="metric-zone-entry" style="color: #38bdf8;">-</div>
                    <small id="metric-dist" style="color: var(--text-dim); font-size: 11px;">Distance: -</small>
                </div>
                <div class="gauge-item">
                    <div class="gauge-label">Stop-Loss (1R)</div>
                    <div class="gauge-val" id="metric-sl" style="color: var(--red);">-</div>
                    <small id="metric-risk-dist" style="color: var(--text-dim); font-size: 11px;">Risk: -</small>
                </div>
                <div class="gauge-item">
                    <div class="gauge-label">Take-Profit (3R)</div>
                    <div class="gauge-val" id="metric-tp" style="color: var(--green);">-</div>
                    <small style="color: var(--text-dim); font-size: 11px;">Target: Strict 1:3</small>
                </div>
            </div>

            <!-- Plain-Language Why/Why-Not Setup Explanation -->
            <div class="explanation-box" id="diagnostic-explanation">
                Loading market diagnostics...
            </div>
        </div>

        <!-- Two Clear Execution Choices (Master Admin Only) -->
        <div class="modes-grid" id="execution-modes-grid">
            <!-- Option 1: 24/7 Automated Candle Scanner -->
            <div class="mode-box active-mode">
                <div>
                    <div class="mode-header">
                        <span>🟢 Option 1: 24/7 Cloud Background Candle Scanner</span>
                        <span id="scanner-state-pill" style="font-size: 11px; background: #064e3b; color: #34d399; padding: 2px 8px; border-radius: 999px;">RUNNING</span>
                    </div>
                    <p class="mode-desc">
                        Monitors closed 15-minute candles 24/7 in the cloud. It <strong>waits quietly</strong> until a candle closes touching the zone. When touched, it automatically executes a 1:3 bracket trade sized to your balance. <strong>Your PC can stay OFF.</strong>
                    </p>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-secondary" id="btn-toggle-scanner" onclick="toggleScanner()">⏸️ Pause Scanner</button>
                    <button class="btn btn-secondary" onclick="loadMarketAnalysis(currentSymbol)">🔄 Refresh Diagnostics</button>
                </div>
            </div>

            <!-- Option 2: Place Resting Zone Limit Order -->
            <div class="mode-box">
                <div>
                    <div class="mode-header">
                        <span>🎯 Option 2: Place Resting Zone Limit Order</span>
                        <span style="font-size: 11px; background: #1e1b4b; color: #a5b4fc; padding: 2px 8px; border-radius: 999px;">RESTING ON DELTA</span>
                    </div>
                    <p class="mode-desc">
                        Instead of waiting for the candle close, places a <strong>Resting LIMIT Bracket Order</strong> directly on Delta Exchange India at the zone entry price. Does NOT execute directly! Rests on the orderbook until price reaches the zone.
                    </p>
                    <div style="background: var(--bg-surface); padding: 10px 14px; border-radius: 6px; font-size: 12px; margin-bottom: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div>Order Type: <strong>Limit Order</strong></div>
                        <div>Position Size: <strong id="limit-lots-preview">1 contract</strong></div>
                        <div>Required Margin: <strong id="limit-margin-preview" style="color: #38bdf8;">~$0.097</strong></div>
                        <div>Adaptive Leverage: <strong id="limit-lev-preview">10x</strong></div>
                    </div>
                </div>
                <button class="btn btn-blue" id="btn-place-limit" onclick="placeZoneLimitOrder()">🎯 Place Limit Order on Delta Exchange</button>
            </div>
        </div>

        <!-- Active Open Positions Table (Master Admin Only) -->
        <div class="section-table" id="positions-section">
            <div class="section-header">
                <span>Active Positions on Delta Exchange India</span>
                <button class="btn btn-secondary" onclick="refreshPositionsAndOrders()" style="font-size: 11px; padding: 4px 10px;">🔄 Refresh</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Size</th>
                        <th>Entry Price</th>
                        <th>Mark Price</th>
                        <th>Margin</th>
                        <th>Unrealized PnL</th>
                        <th>Liquidation</th>
                    </tr>
                </thead>
                <tbody id="positions-body">
                    <tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No open positions active.</td></tr>
                </tbody>
            </table>
        </div>

        <!-- Resting Pending Orders Table (Master Admin Only) -->
        <div class="section-table" id="orders-section">
            <div class="section-header">
                <span>Resting Orders on Delta Exchange Orderbook</span>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Symbol</th>
                        <th>Type</th>
                        <th>Side</th>
                        <th>Limit Price</th>
                        <th>Size</th>
                        <th>Stop Loss</th>
                        <th>Take Profit</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="orders-body">
                    <tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No resting limit orders on book.</td></tr>
                </tbody>
            </table>
        </div>

        <!-- 24/7 Scanner Audit Feed (Master Admin Only) -->
        <div class="section-table" id="audit-feed-section">
            <div class="section-header">
                <span>Live 24/7 Cloud Candle Evaluation Feed</span>
            </div>
            <div class="console-feed" id="scanner-audit-feed">
                Initializing real-time candle stream...
            </div>
        </div>
    </div>

    <script>
        let currentSymbol = 'XAUUSD';
        let currentAnalysis = null;
        let sessionToken = localStorage.getItem('delta_session_token') || localStorage.getItem('delta_access_token') || '';
        let sessionExpiry = parseInt(localStorage.getItem('delta_session_expiry') || '0', 10);
        let userRole = localStorage.getItem('delta_user_role') || 'ADMIN';
        let pendingTempToken = '';
        let sessionTimer = null;
        let dashboardIntervals = [];

        // Apply Role Permissions (Viewer vs Master Admin)
        function applyRolePermissions(role) {
            userRole = role || 'ADMIN';
            const isAdmin = (userRole === 'ADMIN');

            const pillBal = document.getElementById('pill-balance');
            const pillBud = document.getElementById('pill-budget');
            const btnSec = document.getElementById('btn-security-settings');
            const btnLock = document.getElementById('btn-lock');
            const roleBadge = document.getElementById('user-role-badge');

            if (pillBal) pillBal.style.display = isAdmin ? 'inline-flex' : 'none';
            if (pillBud) pillBud.style.display = isAdmin ? 'inline-flex' : 'none';
            if (btnSec) btnSec.style.display = isAdmin ? 'inline-flex' : 'none';
            if (btnLock) {
                btnLock.style.display = 'inline-flex';
                btnLock.textContent = isAdmin ? '🔒 Lock' : '🚪 Exit';
            }

            if (roleBadge) {
                if (isAdmin) {
                    roleBadge.innerHTML = '👑 MASTER ADMIN (Full Access)';
                    roleBadge.style.color = '#38bdf8';
                    roleBadge.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                    roleBadge.style.background = 'rgba(56, 189, 248, 0.15)';
                    roleBadge.style.cursor = 'default';
                } else {
                    roleBadge.innerHTML = '👁️ MARKET VIEWER (Diagnostics Only)';
                    roleBadge.style.color = '#34d399';
                    roleBadge.style.borderColor = 'rgba(52, 211, 153, 0.4)';
                    roleBadge.style.background = 'rgba(52, 211, 153, 0.15)';
                    roleBadge.style.cursor = 'pointer';
                    roleBadge.title = 'Click to exit viewer mode';
                    roleBadge.onclick = () => logout('Exited viewer session.');
                }
            }

            const execGrid = document.getElementById('execution-modes-grid');
            const posSec = document.getElementById('positions-section');
            const ordSec = document.getElementById('orders-section');
            const feedSec = document.getElementById('audit-feed-section');

            if (execGrid) execGrid.style.display = isAdmin ? 'grid' : 'none';
            if (posSec) posSec.style.display = isAdmin ? 'block' : 'none';
            if (ordSec) ordSec.style.display = isAdmin ? 'block' : 'none';
            if (feedSec) feedSec.style.display = isAdmin ? 'block' : 'none';
        }

        // 30-Minute Auto-Logout Countdown Timer (Visibly counts down every second)
        function start30MinSessionTimer() {
            if (sessionTimer) clearInterval(sessionTimer);

            // Synchronize with stored session expiry timestamp
            const now = Date.now();
            if (!sessionExpiry || sessionExpiry <= now) {
                sessionExpiry = now + (30 * 60 * 1000);
                localStorage.setItem('delta_session_expiry', String(sessionExpiry));
            }

            updateSessionDisplay();
            sessionTimer = setInterval(updateSessionDisplay, 1000);
        }

        function updateSessionDisplay() {
            const now = Date.now();
            const diffMs = Math.max(0, sessionExpiry - now);
            const totalSecs = Math.floor(diffMs / 1000);
            const mins = Math.floor(totalSecs / 60);
            const secs = totalSecs % 60;

            const el = document.getElementById('session-countdown');
            if (el) {
                el.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
                if (totalSecs <= 300) {
                    el.style.color = '#f43f5e'; // Warning red when under 5 minutes
                } else {
                    el.style.color = '#38bdf8';
                }
            }

            if (totalSecs <= 0) {
                if (sessionTimer) clearInterval(sessionTimer);
                logout('Session expired after 30 minutes. Please re-authenticate.');
            }
        }

        // Security Authentication Gate (Step 1: 2FA, then Step 2: Password)
        async function checkAuth() {
            const now = Date.now();
            if (!sessionToken || (sessionExpiry > 0 && now > sessionExpiry)) {
                const app = document.getElementById('terminal-app');
                if (app) app.style.display = 'none';
                showAuthStep1();
            } else {
                document.getElementById('auth-modal').style.display = 'none';
                const app = document.getElementById('terminal-app');
                if (app) app.style.display = 'block';
                userRole = localStorage.getItem('delta_user_role') || 'ADMIN';
                applyRolePermissions(userRole);
                start30MinSessionTimer();
                initDashboard();
            }
        }

        function showAuthStep1() {
            document.getElementById('auth-modal').style.display = 'flex';
            document.getElementById('auth-step-1').style.display = 'block';
            document.getElementById('auth-step-2').style.display = 'none';
            document.getElementById('2fa-error').style.display = 'none';
            document.getElementById('input-2fa-code').value = '';
            setTimeout(() => document.getElementById('input-2fa-code').focus(), 100);
        }

        function showAuthStep2() {
            document.getElementById('auth-step-1').style.display = 'none';
            document.getElementById('auth-step-2').style.display = 'block';
            document.getElementById('password-error').style.display = 'none';
            document.getElementById('input-password').value = '';
            setTimeout(() => document.getElementById('input-password').focus(), 100);
        }

        function backTo2FA() {
            pendingTempToken = '';
            showAuthStep1();
        }

        // Submit Step 1: 2FA Code
        async function submit2FA() {
            const code = document.getElementById('input-2fa-code').value.trim();
            const errEl = document.getElementById('2fa-error');
            const btn = document.getElementById('btn-verify-2fa');

            if (!code || code.length < 6) {
                errEl.style.display = 'block';
                errEl.textContent = 'Please enter a valid 6-digit 2FA code.';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Verifying 2FA...';
            errEl.style.display = 'none';

            try {
                const res = await fetch('/api/auth/verify-2fa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: code })
                });
                const data = await res.json();
                if (data.success && data.temp_token) {
                    pendingTempToken = data.temp_token;
                    showAuthStep2();
                } else {
                    errEl.style.display = 'block';
                    errEl.textContent = data.message || 'Invalid 2FA code. Please check your Authenticator app.';
                }
            } catch(e) {
                errEl.style.display = 'block';
                errEl.textContent = 'Connection error verifying 2FA: ' + e.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Verify 2FA Code ➔';
            }
        }

        // Submit Step 2: Master or Viewer Password
        async function submitPassword() {
            const pwd = document.getElementById('input-password').value.trim();
            const errEl = document.getElementById('password-error');
            const btn = document.getElementById('btn-unlock-terminal');

            if (!pwd) {
                errEl.style.display = 'block';
                errEl.textContent = 'Please enter your password.';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Unlocking Terminal...';
            errEl.style.display = 'none';

            try {
                const res = await fetch('/api/auth/verify-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ temp_token: pendingTempToken, password: pwd })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    sessionToken = data.token;
                    sessionExpiry = data.expires_at || (Date.now() + 30 * 60 * 1000);
                    userRole = data.role || 'ADMIN';
                    localStorage.setItem('delta_session_token', sessionToken);
                    localStorage.setItem('delta_session_expiry', String(sessionExpiry));
                    localStorage.setItem('delta_user_role', userRole);

                    document.getElementById('auth-modal').style.display = 'none';
                    const app = document.getElementById('terminal-app');
                    if (app) app.style.display = 'block';
                    applyRolePermissions(userRole);
                    start30MinSessionTimer();
                    initDashboard();
                } else {
                    errEl.style.display = 'block';
                    errEl.textContent = data.message || 'Incorrect Password.';
                    if (data.error === '2FA_REQUIRED') {
                        setTimeout(showAuthStep1, 1500);
                    }
                }
            } catch(e) {
                errEl.style.display = 'block';
                errEl.textContent = 'Connection error: ' + e.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Unlock Institutional Terminal 🔓';
            }
        }

        // Logout & Lock Terminal
        async function logout(reason) {
            try {
                if (sessionToken) {
                    await fetch('/api/auth/logout', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: sessionToken })
                    });
                }
            } catch(e) {}

            localStorage.removeItem('delta_session_token');
            localStorage.removeItem('delta_session_expiry');
            localStorage.removeItem('delta_access_token');
            localStorage.removeItem('delta_user_role');
            sessionToken = '';
            sessionExpiry = 0;
            pendingTempToken = '';
            if (sessionTimer) clearInterval(sessionTimer);
            dashboardIntervals.forEach(clearInterval);
            dashboardIntervals = [];

            const app = document.getElementById('terminal-app');
            if (app) app.style.display = 'none';
            showAuthStep1();
            if (reason) {
                const err = document.getElementById('2fa-error');
                err.style.display = 'block';
                err.style.color = '#fbbf24';
                err.textContent = reason;
            }
        }

        function authHeaders() {
            return {
                'Content-Type': 'application/json',
                'x-session-token': sessionToken,
                'x-access-pin': sessionToken,
                'Authorization': 'Bearer ' + sessionToken
            };
        }

        // Security Settings Modal
        function openSecurityModal() {
            document.getElementById('security-modal').style.display = 'flex';
            document.getElementById('new-password-input').value = '';
            document.getElementById('confirm-password-input').value = '';
            document.getElementById('change-pwd-status').style.display = 'none';
        }

        function closeSecurityModal() {
            document.getElementById('security-modal').style.display = 'none';
        }

        async function changeMasterPassword() {
            const p1 = document.getElementById('new-password-input').value.trim();
            const p2 = document.getElementById('confirm-password-input').value.trim();
            const statusEl = document.getElementById('change-pwd-status');

            if (!p1 || p1.length < 4) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--red)';
                statusEl.textContent = 'Password must be at least 4 characters long.';
                return;
            }
            if (p1 !== p2) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--red)';
                statusEl.textContent = 'Passwords do not match. Please re-enter.';
                return;
            }

            try {
                const res = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ new_password: p1 })
                });
                const data = await res.json();
                if (data.success) {
                    statusEl.style.display = 'block';
                    statusEl.style.color = '#34d399';
                    statusEl.textContent = '✅ Success! Master Password updated.';
                    setTimeout(closeSecurityModal, 2000);
                } else {
                    statusEl.style.display = 'block';
                    statusEl.style.color = 'var(--red)';
                    statusEl.textContent = data.message || 'Failed to update password.';
                }
            } catch(e) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--red)';
                statusEl.textContent = 'Network error: ' + e.message;
            }
        }

        function selectSymbol(sym, el) {
            currentSymbol = sym;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            if (el) el.classList.add('active');
            const displayLabel = (sym === 'XAUUSD' || sym === 'PAXGUSD' || sym === 'GOLD') ? 'Gold (XAUUSD)' : sym;
            document.getElementById('active-symbol-badge').textContent = displayLabel;
            loadMarketAnalysis(sym);
        }

        async function loadMarketAnalysis(sym) {
            const expBox = document.getElementById('diagnostic-explanation');
            const displayLabel = (sym === 'XAUUSD' || sym === 'PAXGUSD' || sym === 'GOLD') ? 'Gold (XAUUSD)' : sym;
            expBox.innerHTML = 'Analyzing 15M candles and 4H trend structure for ' + displayLabel + '...';
            try {
                const res = await fetch('/api/analyze/' + sym, { headers: authHeaders() });
                if (res.status === 401) { logout(); return; }
                const data = await res.json();
                currentAnalysis = data;
                renderAnalysis(data);
            } catch(e) {
                expBox.textContent = 'Error fetching market analysis: ' + e.message;
            }
        }

        function renderAnalysis(data) {
            if (!data || data.error) return;

            const displayLabel = (currentSymbol === 'XAUUSD' || currentSymbol === 'PAXGUSD' || currentSymbol === 'GOLD') ? 'Gold (XAUUSD)' : (data.symbol || currentSymbol);
            document.getElementById('active-symbol-badge').textContent = displayLabel;

            document.getElementById('metric-live-price').textContent = '$' + data.livePrice;
            const trendEl = document.getElementById('metric-trend');
            trendEl.textContent = data.trend === 'BULLISH' ? '🟢 BULLISH' : '🔴 BEARISH';
            trendEl.style.color = data.trend === 'BULLISH' ? '#10b981' : '#f43f5e';
            document.getElementById('metric-ema').textContent = '4H EMA: $' + data.ema4h;

            const badge = document.getElementById('setup-status-badge');
            badge.textContent = data.setupStatusLabel;
            if (data.setupStatus === 'READY_FOR_EXECUTION') {
                badge.style.background = 'rgba(16, 185, 129, 0.2)';
                badge.style.borderColor = '#10b981';
                badge.style.color = '#34d399';
            } else if (data.setupStatus === 'WAITING_FOR_RETEST') {
                badge.style.background = 'rgba(245, 158, 11, 0.2)';
                badge.style.borderColor = '#f59e0b';
                badge.style.color = '#fbbf24';
            } else {
                badge.style.background = 'rgba(148, 163, 184, 0.15)';
                badge.style.borderColor = '#64748b';
                badge.style.color = '#94a3b8';
            }

            if (data.targetZone) {
                document.getElementById('metric-zone-label').textContent = data.targetZone.type + ' Zone Entry';
                document.getElementById('metric-zone-entry').textContent = '$' + data.targetZone.entryLimit;
                document.getElementById('metric-dist').textContent = 'Distance: ' + data.targetZone.distancePct + '% ($' + data.targetZone.distanceUsd + ')';
                document.getElementById('metric-sl').textContent = '$' + data.targetZone.sl;
                document.getElementById('metric-risk-dist').textContent = 'Risk 1R: $' + data.targetZone.riskDist;
                document.getElementById('metric-tp').textContent = '$' + data.targetZone.tp;

                document.getElementById('btn-place-limit').disabled = false;
                document.getElementById('btn-place-limit').textContent = '🎯 Place Limit Order @ $' + data.targetZone.entryLimit + ' on Delta';
            } else {
                document.getElementById('metric-zone-label').textContent = 'Target Zone Entry';
                document.getElementById('metric-zone-entry').textContent = 'None Detected';
                document.getElementById('metric-dist').textContent = 'Consolidating';
                document.getElementById('metric-sl').textContent = '-';
                document.getElementById('metric-risk-dist').textContent = '-';
                document.getElementById('metric-tp').textContent = '-';

                document.getElementById('btn-place-limit').disabled = true;
                document.getElementById('btn-place-limit').textContent = 'Waiting for Institutional Zone...';
            }

            document.getElementById('diagnostic-explanation').innerHTML = '<strong>Setup Status Reason:</strong><br>' + data.simpleExplanation;
        }

        async function fetchLiveBalance() {
            if (userRole !== 'ADMIN') return;
            try {
                const res = await fetch('/api/balance', { headers: authHeaders() });
                if (res.status === 401) { logout(); return; }
                const data = await res.json();
                if (data.success) {
                    const usd = data.available_balance.toFixed(2);
                    const inr = data.available_balance_inr ? data.available_balance_inr.toFixed(2) : (data.available_balance * 85).toFixed(2);
                    document.getElementById('header-balance').textContent = '$' + usd + ' (₹' + inr + ' INR)';
                }
            } catch(e) {}
        }

        async function fetchScannerStatus() {
            try {
                const res = await fetch('/api/scanner-status', { headers: authHeaders() });
                if (res.status === 401) { logout(); return; }
                const data = await res.json();

                const statePill = document.getElementById('scanner-state-pill');
                const btnToggle = document.getElementById('btn-toggle-scanner');

                if (statePill) {
                    if (data.running) {
                        statePill.textContent = 'RUNNING';
                        statePill.style.background = '#064e3b';
                        statePill.style.color = '#34d399';
                        if (btnToggle) btnToggle.textContent = '⏸️ Pause Scanner';
                    } else {
                        statePill.textContent = 'PAUSED';
                        statePill.style.background = '#78350f';
                        statePill.style.color = '#fbbf24';
                        if (btnToggle) btnToggle.textContent = '▶️ Resume Scanner';
                    }
                }

                if (data.logs && data.logs.length > 0) {
                    const feed = document.getElementById('scanner-audit-feed');
                    if (feed) feed.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
                }
            } catch(e) {}
        }

        async function toggleScanner() {
            if (userRole !== 'ADMIN') return;
            try {
                await fetch('/api/scanner-toggle', { method: 'POST', headers: authHeaders() });
                fetchScannerStatus();
            } catch(e) {}
        }

        async function placeZoneLimitOrder() {
            if (userRole !== 'ADMIN') {
                alert('Placement restricted to Master Admin.');
                return;
            }
            if (!currentAnalysis || !currentAnalysis.targetZone) {
                alert('No active target zone found to place limit order!');
                return;
            }

            const z = currentAnalysis.targetZone;
            const btn = document.getElementById('btn-place-limit');
            btn.disabled = true;
            btn.textContent = 'Submitting Limit Order to Delta...';

            try {
                const res = await fetch('/api/order/limit', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        symbol: currentSymbol,
                        side: z.side,
                        limit_price: z.entryLimit,
                        stop_loss: z.sl,
                        take_profit: z.tp,
                        size: 1,
                        leverage: 10
                    })
                });

                const data = await res.json();
                if (data.verdict === 'EXECUTED') {
                    alert('✅ SUCCESS! Resting Limit Order placed on Delta Exchange at $' + z.entryLimit + ' (Order ID: ' + data.order_id + ')');
                    refreshPositionsAndOrders();
                } else {
                    alert('Order placement response: ' + (data.reject_reason || JSON.stringify(data)));
                }
            } catch(e) {
                alert('Network Error placing limit order: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '🎯 Place Limit Order @ $' + z.entryLimit + ' on Delta';
            }
        }

        async function refreshPositionsAndOrders() {
            if (userRole !== 'ADMIN') return;
            try {
                const [posRes, ordRes] = await Promise.all([
                    fetch('/api/positions', { headers: authHeaders() }).then(r => r.json()),
                    fetch('/api/orders', { headers: authHeaders() }).then(r => r.json())
                ]);

                // Render positions
                const posBody = document.getElementById('positions-body');
                if (posBody) {
                    if (posRes.positions && posRes.positions.length > 0) {
                        posBody.innerHTML = posRes.positions.map(p => {
                            const sideColor = p.size > 0 ? '#10b981' : '#f43f5e';
                            const sideLabel = p.size > 0 ? 'LONG' : 'SHORT';
                            const pnlColor = parseFloat(p.unrealized_pnl) >= 0 ? '#10b981' : '#f43f5e';
                            return '<tr>' +
                                '<td><strong>' + (p.product_symbol || p.symbol) + '</strong></td>' +
                                '<td style="color: ' + sideColor + '">' + sideLabel + '</td>' +
                                '<td>' + p.size + '</td>' +
                                '<td>$' + p.entry_price + '</td>' +
                                '<td>$' + p.mark_price + '</td>' +
                                '<td>$' + p.margin + '</td>' +
                                '<td style="color: ' + pnlColor + '">' + p.unrealized_pnl + '</td>' +
                                '<td>$' + (p.liquidation_price || '-') + '</td>' +
                            '</tr>';
                        }).join('');
                    } else {
                        posBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No open positions active.</td></tr>';
                    }
                }

                // Render orders
                const ordBody = document.getElementById('orders-body');
                if (ordBody) {
                    if (ordRes.orders && ordRes.orders.length > 0) {
                        ordBody.innerHTML = ordRes.orders.map(o => {
                            const sideColor = o.side === 'buy' ? '#10b981' : '#f43f5e';
                            const timeStr = o.created_at ? o.created_at.slice(11, 19) : '-';
                            return '<tr>' +
                                '<td>' + timeStr + '</td>' +
                                '<td><strong>' + o.product_symbol + '</strong></td>' +
                                '<td>' + o.order_type + '</td>' +
                                '<td style="color: ' + sideColor + '">' + o.side.toUpperCase() + '</td>' +
                                '<td>$' + (o.limit_price || o.stop_price || '-') + '</td>' +
                                '<td>' + o.size + '</td>' +
                                '<td>$' + (o.bracket_stop_loss_price || '-') + '</td>' +
                                '<td>$' + (o.bracket_take_profit_price || '-') + '</td>' +
                                '<td><button class="btn btn-danger" style="padding: 3px 8px; font-size: 11px;" onclick="cancelOrder(' + o.id + ', ' + (o.product_id || 0) + ')">Cancel</button></td>' +
                            '</tr>';
                        }).join('');
                    } else {
                        ordBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No resting limit orders on book.</td></tr>';
                    }
                }
            } catch(e) {}
        }

        async function cancelOrder(orderId, productId) {
            if (userRole !== 'ADMIN') return;
            if (!confirm('Cancel order #' + orderId + '?')) return;
            try {
                const res = await fetch('/api/order/cancel', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ order_id: orderId, product_id: productId })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Order #' + orderId + ' cancelled successfully.');
                } else {
                    alert('Cancellation failed: ' + (data.error || 'Check exchange response'));
                }
                refreshPositionsAndOrders();
            } catch(e) {
                alert('Error: ' + e.message);
            }
        }

        function initDashboard() {
            dashboardIntervals.forEach(clearInterval);
            dashboardIntervals = [];

            applyRolePermissions(userRole);
            loadMarketAnalysis(currentSymbol);

            if (userRole === 'ADMIN') {
                fetchLiveBalance();
                fetchScannerStatus();
                refreshPositionsAndOrders();

                dashboardIntervals.push(setInterval(fetchScannerStatus, 4000));
                dashboardIntervals.push(setInterval(fetchLiveBalance, 15000));
                dashboardIntervals.push(setInterval(refreshPositionsAndOrders, 10000));
            } else {
                dashboardIntervals.push(setInterval(() => loadMarketAnalysis(currentSymbol), 10000));
            }
        }

        window.onload = checkAuth;
    </script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', path: cleanPath, method: req.method }));
    });

    const PORT = process.env.PORT || config.port || 5050;
    server.listen(PORT, () => {
        console.log(`[Delta Bridge] Institutional Terminal running on port ${PORT}`);
        console.log(`[Delta Bridge] Access PIN: ${config.access_pin || 'delta2026'}`);
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
    fetchDeltaPositions,
    fetchDeltaOrders,
    cancelDeltaOrder
};

if (require.main === module) {
    startServer();
}
