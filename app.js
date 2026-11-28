/**
 * Master 24/7 Cloud Entrypoint - Option 2
 * 
 * Runs Delta Exchange Execution Bridge + Background Candle Scanner 24/7 in the Cloud.
 * Your personal computer can be turned OFF.
 */

const { startServer, setActiveScanner, loadConfig } = require('./delta_bridge');
const StrategyScanner = require('./strategy_scanner');

console.log('=============================================================');
console.log('   DELTA EXCHANGE 24/7 CLOUD AUTOMATED TRADING SYSTEM        ');
console.log('   Strategy: "Dual-Target Institutional Flow" (15M Chart)    ');
console.log('   Mode: Option 2 (24/7 Cloud Background Candle Scanner)    ');
console.log('=============================================================\n');

// 1. Load system configuration
const config = loadConfig();
const rawSymbols = process.env.SCAN_SYMBOLS ? process.env.SCAN_SYMBOLS.split(',') : ['BTCUSD', 'ETHUSD', 'XRPUSD', 'PAXGUSD'];
const symbols = rawSymbols.map(s => s.trim().toUpperCase()).filter(s => s !== 'SOLUSD');
const scanIntervalSeconds = parseInt(process.env.SCAN_INTERVAL_SECONDS || '60', 10);

console.log(`[INIT] Environment: ${config.delta.environment.toUpperCase()}`);
console.log(`[INIT] Multi-Asset Watchlist: ${symbols.join(', ')} (15-Minute Candles)`);
console.log(`[INIT] Scan Frequency: Every ${scanIntervalSeconds} seconds across all assets`);
console.log(`[INIT] Daily Trades: Unlimited (No Limit)`);
console.log(`[INIT] Multi-Stage WhatsApp Pre-Alerts: Active (Formed, Approaching 1-2 min, Retest Confirmed)`);
console.log(`[INIT] Adaptive Leverage & Margin Guard: Active\n`);

// 2. Start HTTP Webhook & Dashboard Server
const server = startServer();

// 3. Initialize & Start 24/7 Multi-Asset Candle Scanner
const scanner = new StrategyScanner({
    symbols: symbols,
    intervalMs: scanIntervalSeconds * 1000
});

// Attach scanner to server so dashboard can display live scanner state & logs
setActiveScanner(scanner);

// Start scanning
scanner.start();

// Graceful shutdown handlers
function handleShutdown(signal) {
    console.log(`\n[SHUTDOWN] Received ${signal}. Stopping scanner and closing server...`);
    scanner.stop();
    server.close(() => {
        console.log('[SHUTDOWN] Clean exit completed.');
        process.exit(0);
    });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
