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
const symbol = process.env.SCAN_SYMBOL || 'XRPUSD';
const scanIntervalSeconds = parseInt(process.env.SCAN_INTERVAL_SECONDS || '60', 10);

console.log(`[INIT] Environment: ${config.delta.environment.toUpperCase()}`);
console.log(`[INIT] Target Symbol: ${symbol} (15-Minute Candles)`);
console.log(`[INIT] Scan Frequency: Every ${scanIntervalSeconds} seconds`);
console.log(`[INIT] Max Daily Trades: 3 (Enforced calendar-day limit)`);
console.log(`[INIT] Adaptive Leverage: Active (Auto-sizes for ₹51 / $0.60+ capital)\n`);

// 2. Start HTTP Webhook & Dashboard Server
const server = startServer();

// 3. Initialize & Start 24/7 Candle Scanner
const scanner = new StrategyScanner({
    symbol: symbol,
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
