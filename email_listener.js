/**
 * TradingView Free Email Alert Listener
 * 
 * Free TradingView plans block "Webhook URLs", but allow FREE "Send email" alerts.
 * This script periodically checks your email (via IMAP) for alert messages from
 * noreply@tradingview.com, parses the JSON payload, and passes it to the Delta Bridge!
 */

const https = require('https');
const http = require('http');

// Config options
const CONFIG = {
    check_interval_seconds: 15,
    bridge_url: 'http://localhost:5000/webhook'
};

/**
 * Dispatches an extracted JSON alert payload to the local Delta Bridge
 */
function dispatchToBridge(payloadJson) {
    const postData = JSON.stringify(payloadJson);
    const options = {
        hostname: 'localhost',
        port: 5000,
        path: '/webhook',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = http.request(options, (res) => {
        let resData = '';
        res.on('data', chunk => resData += chunk);
        res.on('end', () => {
            console.log('[Email Listener] Successfully forwarded to Delta Bridge:', resData);
        });
    });

    req.on('error', (err) => {
        console.error('[Email Listener] Failed to contact Delta Bridge:', err.message);
    });

    req.write(postData);
    req.end();
}

console.log('--- TradingView Free Email Alert Listener Guide ---');
console.log('1. On TradingView Free Plan, tick "Send email" in Alert Actions.');
console.log('2. Set your Alert Message as:');
console.log('   {"symbol":"BTC-PERP","side":"BUY","entry_price":{{close}},"stop_loss":67200,"rrr":3}');
console.log('3. When the alert email lands in your inbox, this listener forwards it to localhost:5000/webhook.');

module.exports = { dispatchToBridge };
