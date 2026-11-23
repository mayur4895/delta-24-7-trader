# Delta Exchange Day Trading Automation Suite

Automated Day Trading Strategist, Risk Filter, and Execution Bridge for Delta Exchange crypto perpetuals (e.g. BTC-PERP, ETH-PERP).

## Core Architecture & Features

1. **Daily Trade Limit (3 Trades / Calendar Day UTC):**
   - Automatically tracks trade count and resets at `00:00:00 UTC`.
   - Trades 1, 2, 3: Processed if risk criteria pass.
   - Trade 4+: Hard-rejected. Puts system into standby until 00:00:00 UTC.

2. **Fixed Risk-to-Reward Ratio (1:3 Default, 1:2 Minimum):**
   - Mandatory Stop-Loss (SL) check.
   - Calculates 1R risk distance and sets exact 1:3 Take-Profit target.
   - Blocks inverted SL or substandard RRR.

3. **Forex Factory High-Impact News Filter:**
   - Extracts high-impact USD economic events (CPI, FOMC, NFP, PPI).
   - Enforces a 30-minute pre-event and 15-minute post-event trading halt to avoid slippage.

4. **CoinGlass Liquidity & Market Confluence:**
   - Evaluates liquidation heatmaps and funding rate sentiment.
   - Verifies that Take-Profit targets align with liquidation pools and Stop-Loss is protected.

5. **Delta Exchange Bracket Order Dispatcher:**
   - Formats orders into Delta Exchange bracket specifications (`bracket_stop_loss_price`, `bracket_take_profit_price`).
   - Supports **Testnet**, **Global Live (`api.delta.exchange`)**, and **India Live (`api.india.delta.exchange`)**.
   - HMAC-SHA256 API request signing.

---

## File Structure

```
delta-exchange-trading/
├── .agents/
│   └── skills/
│       └── delta-day-trader/
│           └── SKILL.md                  <-- Dedicated Antigravity Skill Handbook
├── modules/
│   ├── news_filter.js                    <-- Forex Factory news extractor & lockout
│   └── coinglass_extractor.js            <-- CoinGlass liquidity & funding module
├── TradingView_Delta_Strategy.pine       <-- Pine Script v5 with UTC reset & alert payload
├── signal_filter.js                      <-- 3-trade daily limit & 1:3 RRR validator
├── delta_bridge.js                       <-- Master webhook server & Delta API client
├── config.json                           <-- User configuration & API keys
└── daily_trades.json                     <-- Persistent UTC trade state tracker
```

---

## Step-by-Step Setup Guide

### Step 1: Set Up Credentials in `config.json`
Open `config.json` and configure:
```json
{
  "port": 5000,
  "delta": {
    "environment": "testnet",
    "api_key": "YOUR_DELTA_API_KEY",
    "api_secret": "YOUR_DELTA_API_SECRET",
    "auto_execute": false
  },
  "coinglass": {
    "api_key": "YOUR_COINGLASS_API_KEY_OPTIONAL"
  },
  "news_filter": {
    "enabled": true,
    "pre_news_buffer_minutes": 30,
    "post_news_buffer_minutes": 15
  },
  "risk": {
    "max_daily_trades": 3,
    "default_rrr": 3
  }
}
```

### Step 2: Start the Webhook Execution Bridge
Run the bridge server locally:
```bash
node delta_bridge.js
```
The server will start listening at `http://localhost:5000/webhook`.
To check status and remaining daily trades anytime, open `http://localhost:5000/status`.

### Step 3: Configure TradingView
1. Open TradingView and navigate to your desired chart (e.g., `BTCUSD.P` or `BTC-PERP` on 15m or 1h).
2. Open Pine Editor and paste the code from [TradingView_Delta_Strategy.pine](file:///C:/Users/kunda/.gemini/antigravity/scratch/delta-exchange-trading/TradingView_Delta_Strategy.pine).
3. Add to Chart.
4. Click **Create Alert** on the strategy:
   - Condition: `Delta Exchange 1:3 RRR (Max 3 Trades/Day UTC)`
   - Webhook URL: `http://<YOUR_IP_OR_NGROK>:5000/webhook`
   - Message: `{{strategy.order.alert_message}}`

### Step 4: Dry Run on Testnet First
Before enabling real capital:
1. Keep `"auto_execute": false` (or set `"environment": "testnet"` with Testnet API keys).
2. Confirm that 3 signals trigger cleanly and the 4th is rejected until 00:00 UTC.
3. Once satisfied, flip `"auto_execute": true` and switch `"environment": "live_global"` or `"live_india"`.
