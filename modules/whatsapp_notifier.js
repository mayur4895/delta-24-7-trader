/**
 * WhatsApp Linked Device Notification Engine (Powered by Baileys)
 * 
 * Directly connects as a Linked Device to WhatsApp Web.
 * Automatically delivers trade alerts for all assets to:
 * - 8855964895 (918855964895@s.whatsapp.net)
 * - 9022713613 (919022713613@s.whatsapp.net)
 * 
 * Zero third-party fees. Zero bot capacity issues. 100% automated.
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
const sentSetupSignatures = new Map(); // signature -> timestamp

/**
 * Format pre-trade reminder when a setup is forming
 */
function formatSetupFormingMessage(setup) {
    const symbol = setup.symbol || 'XRPUSD';
    const side = String(setup.direction || setup.side || 'BUY').toUpperCase();
    const isLong = side === 'BUY' || side === 'LONG';
    const directionEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';
    const directionPlain = isLong ? 'LONG' : 'SHORT';

    const entry = setup.entry_price || setup.entryLimit || setup.entry || 'N/A';
    const sl = setup.stop_loss || setup.sl || 'N/A';
    const tp = setup.take_profit || setup.tp || 'N/A';
    const currentPrice = setup.currentPrice || setup.livePrice || 'N/A';
    const distPct = setup.distancePct !== undefined ? setup.distancePct : (setup.distPct || '');
    const statusText = isLong ? '⏳ Waiting for Pullback to Demand' : '⏳ Waiting for Rally to Supply';

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
`🟡 *Delta Setup Alert: Setup Forming*

• Asset: *${symbol}*
• Direction: *${directionEmoji}*
• Status: *${statusText}*
• Planned Entry: *$${entry}*
• Planned Stop Loss: *$${sl}*
• Planned Take Profit: *$${tp}*
• Target RRR: *1:3*
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
 * Send WhatsApp Pre-Trade Reminder when a setup is forming
 */
async function sendWhatsAppSetupFormingAlert(setupData) {
    const symbol = setupData.symbol || 'XRPUSD';
    const entry = setupData.entry_price || setupData.entryLimit || setupData.entry || 'N/A';
    const sl = setupData.stop_loss || setupData.sl || 'N/A';
    const side = (setupData.direction || setupData.side || 'BUY').toUpperCase();

    // Unique signature per setup zone
    const signature = `${symbol}_${side}_${entry}_${sl}`;
    const lastSent = sentSetupSignatures.get(signature);
    const now = Date.now();

    // Deduplicate: Don't re-send the exact same forming setup within 2 hours
    if (lastSent && (now - lastSent) < (2 * 60 * 60 * 1000)) {
        return { skipped: true, reason: 'Already notified for this setup zone' };
    }

    sentSetupSignatures.set(signature, now);

    const formatted = formatSetupFormingMessage(setupData);
    const results = [];

    console.log(`\n[WhatsApp Notifier] ══════════════════════════════════════════`);
    console.log(`[WhatsApp Notifier] 🟡 Pre-Trade Reminder: Setup Forming on ${formatted.symbol}...`);

    for (const r of DEFAULT_RECIPIENTS) {
        const jid = `${r.clean}@s.whatsapp.net`;
        if (isConnected && waSocket) {
            try {
                await waSocket.sendMessage(jid, { text: formatted.text });
                console.log(`[WhatsApp Notifier] ✅ Delivered setup reminder to ${r.phone}`);
                results.push({ phone: r.phone, success: true });
            } catch(e) {
                console.error(`[WhatsApp Notifier] ❌ Failed setup reminder to ${r.phone}:`, e.message);
                results.push({ phone: r.phone, success: false, error: e.message });
            }
        }
    }
    console.log(`[WhatsApp Notifier] ══════════════════════════════════════════\n`);

    return { success: true, formatted_message: formatted.text, results };
}

/**
 * Format clean, simple trade alert message with simple icons
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
    
    // Exact Trade Entry Execution Time in Indian Standard Time (IST)
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
`🔔 *Delta Trade Alert: Trade Executed*

• Asset: *${symbol}*
• Direction: *${directionEmoji}*
• Entry: *$${entry}*
• Stop Loss: *$${sl}*
• Take Profit: *$${tp}*
• Target RRR: *${rrr}*
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
            }
        });

    } catch(err) {
        console.error('[WhatsApp] Initialization error:', err.message);
        connectionStatusText = 'Error initializing: ' + err.message;
        setTimeout(initWhatsApp, 10000);
    }
}

/**
 * Send WhatsApp trade alert to all recipients
 */
async function sendWhatsAppTradeAlert(tradeData, config = {}) {
    const formatted = formatTradeAlertMessage(tradeData);
    const results = [];

    console.log(`\n[WhatsApp Notifier] ══════════════════════════════════════════`);
    console.log(`[WhatsApp Notifier] Sending alert for ${formatted.symbol} (${formatted.direction})...`);

    const recipients = DEFAULT_RECIPIENTS;

    for (const r of recipients) {
        const jid = `${r.clean}@s.whatsapp.net`;
        const waLink = `https://api.whatsapp.com/send?phone=${r.clean}&text=${encodeURIComponent(formatted.text)}`;
        let success = false;
        let statusMessage = '';

        if (isConnected && waSocket) {
            try {
                await waSocket.sendMessage(jid, { text: formatted.text });
                success = true;
                statusMessage = `✅ Delivered to ${r.name} (${r.phone}) via Linked Device`;
                console.log(`[WhatsApp Notifier] ✅ Sent to ${r.phone}`);
            } catch(sendErr) {
                statusMessage = `Send error: ${sendErr.message}`;
                console.error(`[WhatsApp Notifier] ❌ Failed to send to ${r.phone}:`, sendErr.message);
            }
        } else {
            statusMessage = `⚠️ WhatsApp not linked yet. Scan QR code on dashboard to enable automatic delivery.`;
            console.log(`[WhatsApp Notifier] ⚠️ WhatsApp not linked yet. (Preview: ${waLink})`);
        }

        results.push({
            phone: r.phone,
            clean: r.clean,
            name: r.name,
            success: success,
            status: statusMessage,
            wa_link: waLink
        });
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
        recent_alerts: alertHistory.slice(0, 5)
    };
}

module.exports = {
    initWhatsApp,
    sendWhatsAppTradeAlert,
    sendWhatsAppSetupFormingAlert,
    sendTestWhatsAppAlert,
    getWhatsAppStatus,
    formatTradeAlertMessage,
    formatSetupFormingMessage,
    DEFAULT_RECIPIENTS
};
