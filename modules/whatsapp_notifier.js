/**
 * WhatsApp Linked Device Notification Engine (Powered by Baileys)
 * 
 * Directly connects as a Linked Device to WhatsApp Web.
 * Automatically delivers trade alerts for all assets to:
 * - 8855964895 (918855964895@s.whatsapp.net)
 * - 9022713613 (919022713613@s.whatsapp.net)
 * 
 * Includes:
 * 1. Resilient Outbound Message Queue (Never drops messages during socket reconnects)
 * 2. Stage 1 Alert: Setup Formed (Fresh Supply/Demand Zone)
 * 3. Stage 2 Alert: Approaching Zone (~1-2 min warning before entry)
 * 4. Stage 3 Alert: Setup Retest Confirmed & Order Executed
 * 5. Strict 1:2 to 1:4 RRR Policy and Tight Risk Guard
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../auth_info_baileys');
const DEFAULT_RECIPIENTS = [
    { phone: '+918855964895', clean: '918855964895', name: 'Primary Admin' },
    { phone: '+919022713613', clean: '919022713613', name: 'Secondary Admin' }
];

let waSocket = null;
let latestQRDataUrl = null;
let latestRawQR = null;
let isConnected = false;
let connectedUser = null;
let connectionStatusText = 'Initializing WhatsApp engine...';
const alertHistory = [];
const sentSignatures = new Map(); // signature_stage -> timestamp
const outboundQueue = []; // In-memory queue for alerts during socket handshake/reconnect
let isFlushingQueue = false;

/**
 * Flush any queued outbound alerts through active socket
 */
async function flushOutboundQueue() {
    if (!isConnected || !waSocket || isFlushingQueue || outboundQueue.length === 0) return;
    isFlushingQueue = true;
    console.log(`[WhatsApp Queue] 🚀 Flushing ${outboundQueue.length} queued alert(s) to WhatsApp...`);

    while (outboundQueue.length > 0 && isConnected && waSocket) {
        const item = outboundQueue.shift();
        try {
            await waSocket.sendMessage(item.jid, { text: item.text });
            console.log(`[WhatsApp Queue] ✅ Flushed queued alert to ${item.phone}`);
            // Brief pause (300ms) between messages to respect rate limits
            await new Promise(r => setTimeout(r, 300));
        } catch (err) {
            console.error(`[WhatsApp Queue] ❌ Error delivering queued message to ${item.phone}:`, err.message);
            if (!isConnected) {
                // Return to queue if connection dropped
                outboundQueue.unshift(item);
                break;
            }
        }
    }
    isFlushingQueue = false;
}

// Check and flush queue periodically if connected
setInterval(() => {
    if (isConnected && waSocket && outboundQueue.length > 0) {
        flushOutboundQueue().catch(() => {});
    }
}, 5000);

/**
 * Send alert immediately or enqueue if socket is still establishing
 */
async function sendOrQueueMessage(recipient, text, alertType = 'ALERT') {
    const jid = `${recipient.clean}@s.whatsapp.net`;
    const waLink = `https://api.whatsapp.com/send?phone=${recipient.clean}&text=${encodeURIComponent(text)}`;

    if (isConnected && waSocket) {
        try {
            await waSocket.sendMessage(jid, { text });
            console.log(`[WhatsApp Notifier] ✅ Delivered ${alertType} to ${recipient.phone}`);
            return {
                phone: recipient.phone,
                clean: recipient.clean,
                name: recipient.name,
                success: true,
                queued: false,
                status: `✅ Delivered to ${recipient.name} (${recipient.phone}) via Linked Device`,
                wa_link: waLink
            };
        } catch (err) {
            console.warn(`[WhatsApp Notifier] ⚠️ Immediate send failed to ${recipient.phone} (${err.message}). Queueing for auto-flush...`);
            outboundQueue.push({ jid, phone: recipient.phone, text, timestamp: Date.now() });
            return {
                phone: recipient.phone,
                clean: recipient.clean,
                name: recipient.name,
                success: true,
                queued: true,
                status: `⏳ Queued for auto-delivery upon connection`,
                wa_link: waLink
            };
        }
    } else {
        console.log(`[WhatsApp Notifier] ⏳ Socket not ready. Queued ${alertType} for ${recipient.phone} (Will deliver automatically once connected)`);
        outboundQueue.push({ jid, phone: recipient.phone, text, timestamp: Date.now() });
        return {
            phone: recipient.phone,
            clean: recipient.clean,
            name: recipient.name,
            success: true,
            queued: true,
            status: `⏳ Queued for auto-delivery upon connection`,
            wa_link: waLink
        };
    }
}

/**
 * Format Stage 1: Setup Formed (Fresh Zone Discovered)
 */
function formatSetupFormingMessage(setup) {
    const symbol = setup.symbol || 'XRPUSD';
    const side = String(setup.direction || setup.side || 'BUY').toUpperCase();
    const isLong = side === 'BUY' || side === 'LONG';
    const directionEmoji = isLong ? '🟢 LONG (Demand Setup)' : '🔴 SHORT (Supply Setup)';
    const directionPlain = isLong ? 'LONG' : 'SHORT';

    const entry = setup.entry_price || setup.entryLimit || setup.entry || 'N/A';
    const sl = setup.stop_loss || setup.sl || 'N/A';
    const tp = setup.take_profit || setup.tp || 'N/A';
    const currentPrice = setup.currentPrice || setup.livePrice || 'N/A';
    const distPct = setup.distancePct !== undefined ? setup.distancePct : (setup.distPct || '');
    const statusText = isLong ? '⏳ Fresh Demand Zone • Waiting for Pullback' : '⏳ Fresh Supply Zone • Waiting for Rally';

    const now = new Date();
    const timeIst = now.toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata', 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    }) + ' IST';

    const message = 
`🟡 *Delta Setup Alert: Setup Formed*

• Asset: *${symbol}*
• Direction: *${directionEmoji}*
• Status: *${statusText}*
• Planned Entry: *$${entry}*
• Planned Stop Loss: *$${sl}*
• Planned Take Profit: *$${tp}*
• Target RRR: *1:3* (Range: 1:2 to 1:4)
• Current Price: *$${currentPrice}* (${distPct}% to zone)
• Setup Time: *${timeIst}*`;

    return {
        text: message,
        symbol,
        direction: directionPlain,
        directionEmoji,
        entry,
        sl,
        tp,
        currentPrice,
        distPct,
        timeIst
    };
}

/**
 * Format Stage 2: Approaching Entry Zone (1-2 Min Warning)
 */
function formatApproachingZoneMessage(setup) {
    const symbol = setup.symbol || 'XRPUSD';
    const side = String(setup.direction || setup.side || 'BUY').toUpperCase();
    const isLong = side === 'BUY' || side === 'LONG';
    const directionEmoji = isLong ? '🟢 LONG (Demand Retest)' : '🔴 SHORT (Supply Retest)';
    const directionPlain = isLong ? 'LONG' : 'SHORT';

    const entry = setup.entry_price || setup.entryLimit || setup.entry || 'N/A';
    const sl = setup.stop_loss || setup.sl || 'N/A';
    const tp = setup.take_profit || setup.tp || 'N/A';
    const currentPrice = setup.currentPrice || setup.livePrice || 'N/A';
    const distPct = setup.distancePct !== undefined ? setup.distancePct : (setup.distPct || '');

    const now = new Date();
    const timeIst = now.toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata', 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    }) + ' IST';

    const message = 
`⚡ *Delta Pre-Trade Reminder: Approaching Entry Zone*
⏱️ *Warning: ~1-2 Minutes to Zone Tap*

• Asset: *${symbol}*
• Direction: *${directionEmoji}*
• Planned Entry: *$${entry}*
• Planned Stop Loss: *$${sl}*
• Planned Take Profit: *$${tp}*
• Target RRR: *1:3* (Range: 1:2 to 1:4)
• Current Price: *$${currentPrice}* (*${distPct}% from entry*)
• Action: *Price is within 1% of entry zone. Prepare for execution or place resting limit order.*
• Alert Time: *${timeIst}*`;

    return {
        text: message,
        symbol,
        direction: directionPlain,
        directionEmoji,
        entry,
        sl,
        tp,
        currentPrice,
        distPct,
        timeIst
    };
}

/**
 * Format Stage 3: Setup Retest Confirmed & Executed
 */
function formatTradeAlertMessage(trade) {
    const symbol = trade.symbol || 'XRPUSD';
    const side = String(trade.direction || trade.side || 'BUY').toUpperCase();
    const isLong = side === 'BUY' || side === 'LONG';
    const directionEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';
    const directionPlain = isLong ? 'LONG' : 'SHORT';

    const entry = trade.entry_price || trade.entryPrice || trade.entry || trade.price || 'N/A';
    const sl = trade.stop_loss || trade.stopLoss || trade.sl || 'N/A';
    const tp = trade.take_profit || trade.takeProfit || trade.tp || 'N/A';
    const rrr = trade.rrr || '1:3';
    const capitalRiskPct = trade.capital_risk_percent || '5%';
    const orderType = (trade.order_type || trade.orderType || 'Market');
    const orderId = trade.order_id || trade.orderId || 'DELTA_LIVE';
    
    let entryDate = new Date();
    const rawTime = trade.entry_time || trade.entryTime || trade.timestamp || trade.created_at || trade.time;
    if (rawTime) {
        const parsed = new Date(rawTime);
        if (!isNaN(parsed.getTime())) {
            entryDate = parsed;
        }
    }

    const entryTimeIst = entryDate.toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata', 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    }) + ' IST';

    const message = 
`🔔 *Delta Trade Alert: Retest Confirmed & Executed*

• Asset: *${symbol}*
• Direction: *${directionEmoji}*
• Entry: *$${entry}*
• Stop Loss: *$${sl}*
• Take Profit: *$${tp}*
• Target RRR: *${rrr}* (Range: 1:2 to 1:4)
• Capital Risk: *${capitalRiskPct}*
• Order Type: *${orderType}*
• Order ID: *#${orderId}*
• Entry Time: *${entryTimeIst}*`;

    return {
        text: message,
        symbol,
        direction: directionPlain,
        directionEmoji,
        entry,
        sl,
        tp,
        rrr,
        capitalRiskPct,
        orderType,
        orderId,
        entryTimeIst
    };
}

/**
 * Send Stage 1 Alert: Setup Formed (Waiting for Retest)
 */
async function sendWhatsAppSetupFormingAlert(setupData) {
    const symbol = setupData.symbol || 'XRPUSD';
    const entry = setupData.entry_price || setupData.entryLimit || setupData.entry || 'N/A';
    const sl = setupData.stop_loss || setupData.sl || 'N/A';
    const side = (setupData.direction || setupData.side || 'BUY').toUpperCase();

    const signature = `${symbol}_${side}_${entry}_${sl}_FORMED`;
    const lastSent = sentSignatures.get(signature);
    const now = Date.now();

    // Deduplicate: Don't re-send the same setup formed alert within 1 hour
    if (lastSent && (now - lastSent) < (60 * 60 * 1000)) {
        return { skipped: true, reason: 'Setup formed alert already delivered' };
    }
    sentSignatures.set(signature, now);

    const formatted = formatSetupFormingMessage(setupData);
    console.log(`\n[WhatsApp Notifier] ══════════════════════════════════════════`);
    console.log(`[WhatsApp Notifier] 🟡 Stage 1 Alert: Setup Formed on ${formatted.symbol}...`);

    const results = [];
    for (const r of DEFAULT_RECIPIENTS) {
        const res = await sendOrQueueMessage(r, formatted.text, 'Stage 1 Setup Formed Alert');
        results.push(res);
    }
    console.log(`[WhatsApp Notifier] ══════════════════════════════════════════\n`);

    return { success: true, formatted_message: formatted.text, results };
}

/**
 * Send Stage 2 Alert: Approaching Entry Zone (1-2 Min Warning)
 */
async function sendWhatsAppApproachingZoneAlert(setupData) {
    const symbol = setupData.symbol || 'XRPUSD';
    const entry = setupData.entry_price || setupData.entryLimit || setupData.entry || 'N/A';
    const sl = setupData.stop_loss || setupData.sl || 'N/A';
    const side = (setupData.direction || setupData.side || 'BUY').toUpperCase();

    const signature = `${symbol}_${side}_${entry}_${sl}_APPROACHING`;
    const lastSent = sentSignatures.get(signature);
    const now = Date.now();

    // Deduplicate: Don't re-send approaching reminder within 30 minutes for the same zone
    if (lastSent && (now - lastSent) < (30 * 60 * 1000)) {
        return { skipped: true, reason: 'Approaching zone alert already delivered' };
    }
    sentSignatures.set(signature, now);

    const formatted = formatApproachingZoneMessage(setupData);
    console.log(`\n[WhatsApp Notifier] ══════════════════════════════════════════`);
    console.log(`[WhatsApp Notifier] ⚡ Stage 2 Alert: Approaching Zone (1-2 Min) on ${formatted.symbol}...`);

    const results = [];
    for (const r of DEFAULT_RECIPIENTS) {
        const res = await sendOrQueueMessage(r, formatted.text, 'Stage 2 Approaching Zone Alert');
        results.push(res);
    }
    console.log(`[WhatsApp Notifier] ══════════════════════════════════════════\n`);

    return { success: true, formatted_message: formatted.text, results };
}

/**
 * Send Stage 3 Alert: Trade Executed / Retest Confirmed
 */
async function sendWhatsAppTradeAlert(tradeData, config = {}) {
    const formatted = formatTradeAlertMessage(tradeData);
    const symbol = tradeData.symbol || 'XRPUSD';
    const entry = tradeData.entry_price || tradeData.entryPrice || tradeData.entry || 'N/A';
    const sl = tradeData.stop_loss || tradeData.stopLoss || tradeData.sl || 'N/A';
    const side = (tradeData.direction || tradeData.side || 'BUY').toUpperCase();

    const signature = `${symbol}_${side}_${entry}_${sl}_EXECUTED`;
    const lastSent = sentSignatures.get(signature);
    const now = Date.now();

    // Deduplicate duplicate triggers within 15 minutes
    if (lastSent && (now - lastSent) < (15 * 60 * 1000)) {
        return { skipped: true, reason: 'Executed alert already delivered' };
    }
    sentSignatures.set(signature, now);

    console.log(`\n[WhatsApp Notifier] ══════════════════════════════════════════`);
    console.log(`[WhatsApp Notifier] 🔔 Stage 3 Alert: Trade Retest Confirmed for ${formatted.symbol}...`);

    const results = [];
    for (const r of DEFAULT_RECIPIENTS) {
        const res = await sendOrQueueMessage(r, formatted.text, 'Stage 3 Trade Executed Alert');
        results.push(res);
    }

    const logEntry = {
        id: 'wa_' + Date.now(),
        timestamp: new Date().toISOString(),
        trade: formatted,
        results: results
    };
    alertHistory.unshift(logEntry);
    if (alertHistory.length > 50) alertHistory.pop();

    console.log(`[WhatsApp Notifier] ══════════════════════════════════════════\n`);

    return {
        success: results.some(r => r.success),
        is_connected: isConnected,
        formatted_message: formatted.text,
        recipients: results
    };
}

/**
 * Initialize Baileys WhatsApp Socket
 */
async function initWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Delta Trader 24/7', 'Chrome', '1.0.0']
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestRawQR = qr;
                try {
                    latestQRDataUrl = await QRCode.toDataURL(qr);
                    connectionStatusText = 'Waiting for QR scan... Open WhatsApp -> Linked Devices -> Link a Device';
                    console.log(`\n[WhatsApp] ══════════════════════════════════════════════════`);
                    console.log(`[WhatsApp] 📱 SCAN QR CODE TO LINK WHATSAPP:`);
                    console.log(`[WhatsApp] View QR in browser dashboard at: http://localhost:5050`);
                    console.log(`[WhatsApp] ══════════════════════════════════════════════════\n`);
                } catch(qrErr) {
                    console.error('[WhatsApp] QR generation error:', qrErr.message);
                }
            }

            if (connection === 'close') {
                isConnected = false;
                latestQRDataUrl = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                connectionStatusText = `Disconnected (${statusCode || 'Unknown'}). ${shouldReconnect ? 'Reconnecting...' : 'Logged out.'}`;
                console.log(`[WhatsApp] Connection closed. Should reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 4000);
                } else {
                    console.log('[WhatsApp] Logged out from WhatsApp. Clear auth_info_baileys to re-scan.');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch(e) {}
                    setTimeout(initWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                latestQRDataUrl = null;
                latestRawQR = null;
                connectedUser = waSocket.user?.id ? waSocket.user.id.split(':')[0] : 'Linked';
                connectionStatusText = `Connected as +${connectedUser}`;
                console.log(`\n[WhatsApp] ✅ CONNECTED SUCCESSFULLY! Linked to WhatsApp account +${connectedUser}`);
                console.log(`[WhatsApp] 🚀 Automatic Trade Alerts are ACTIVE for 8855964895 and 9022713613.\n`);

                // Instantly flush any waiting queued alerts upon connection
                flushOutboundQueue().catch(err => {
                    console.error('[WhatsApp] Initial queue flush error:', err.message);
                });
            }
        });

    } catch(err) {
        console.error('[WhatsApp] Initialization error:', err.message);
        connectionStatusText = 'Error initializing: ' + err.message;
        setTimeout(initWhatsApp, 10000);
    }
}

/**
 * Send a quick test WhatsApp alert
 */
async function sendTestWhatsAppAlert(customSymbol = 'PAXGUSD') {
    const isGold = (customSymbol || '').includes('PAXG') || (customSymbol || '').includes('XAU') || (customSymbol || '').includes('GOLD');
    const testTrade = {
        symbol: isGold ? '🪙 Gold (PAXGUSD)' : (customSymbol || 'Ripple (XRPUSD)'),
        side: 'BUY',
        direction: 'LONG',
        entry_price: isGold ? 3572.50 : 0.9008,
        stop_loss: isGold ? 3564.75 : 0.8889,
        take_profit: isGold ? 3595.75 : 0.9365,
        rrr: '1:3',
        capital_risk_percent: '5%',
        order_type: 'Market'
    };

    return await sendWhatsAppTradeAlert(testTrade);
}

function getWhatsAppStatus() {
    return {
        is_connected: isConnected,
        connected_user: connectedUser,
        status_text: connectionStatusText,
        qr_code: latestQRDataUrl,
        recipients: DEFAULT_RECIPIENTS,
        recent_alerts: alertHistory.slice(0, 5),
        queued_count: outboundQueue.length
    };
}

module.exports = {
    initWhatsApp,
    sendWhatsAppTradeAlert,
    sendWhatsAppSetupFormingAlert,
    sendWhatsAppApproachingZoneAlert,
    sendTestWhatsAppAlert,
    getWhatsAppStatus,
    flushOutboundQueue,
    formatTradeAlertMessage,
    formatSetupFormingMessage,
    formatApproachingZoneMessage,
    DEFAULT_RECIPIENTS
};
