---
name: delta-exchange-day-trader
description: >-
  Automated day trading strategist, signal filter, and execution engine for Delta Exchange crypto futures (BTC-PERP, ETH-PERP).
  Enforces a strict 3 trades/calendar day (UTC) limit, fixed 1:2 or 1:3 risk-to-reward ratio (RRR),
  filters high-impact economic news (Forex Factory), integrates CoinGlass liquidation intelligence,
  and formats/dispatches bracket orders to Delta Exchange.
---

# Delta Exchange Day Trader & Signal Filter Skill

This skill governs autonomous and semi-autonomous crypto perpetual futures trading on Delta Exchange. It acts as an uncompromising risk gatekeeper, signal validator, and execution strategist.

---

## 1. Non-Negotiable Operational Constraints

### Gate 1: Daily Trade Limit (Max 3 Trades / Day UTC)
* **Time Anchor:** Strictly synchronized with **UTC calendar day** (`00:00:00 UTC` to `23:59:59 UTC`).
* **Counter Logic:**
  * Trade 1, 2, 3: Permitted if all subsequent risk and news filters pass.
  * Trade 4+: **HARD STOP / REJECT**.
* **Standby Mode:** Once 3 trades are executed in a UTC day, the agent or bridge must reject all incoming signals until 00:00:00 UTC with:
  ```json
  {
    "status": "REJECTED",
    "reason": "DAILY_LIMIT_EXCEEDED (3/3 trades reached for current UTC day)",
    "standby_until": "00:00:00 UTC"
  }
  ```

### Gate 2: Fixed Risk-to-Reward Ratio (1:2 or 1:3)
* **Default Ratio:** Fixed **1:3** (minimum allowed: 1:2).
* **Mandatory Stop-Loss (SL):** Never accept or pass a signal that lacks a clearly defined invalidation price.
* **Formulas:**
  * **Long/Buy:**
    * $\text{Risk } (1R) = \text{Entry} - \text{StopLoss}$ (where $\text{Entry} > \text{StopLoss}$)
    * $\text{TakeProfit } (3R) = \text{Entry} + (1R \times 3)$
  * **Short/Sell:**
    * $\text{Risk } (1R) = \text{StopLoss} - \text{Entry}$ (where $\text{StopLoss} > \text{Entry}$)
    * $\text{TakeProfit } (3R) = \text{Entry} - (1R \times 3)$
* If a signal provides its own Take-Profit that yields less than 1:2, it is **instantly rejected**.

### Gate 3: High-Impact News Filter (Forex Factory)
* **Source:** Forex Factory Economic Calendar (`ff_calendar_thisweek.json`).
* **Target:** High-impact USD events (e.g. CPI, Core PPI, FOMC rate decisions, Non-Farm Payrolls).
* **Blackout Window:** 
  * 30 minutes before release.
  * 15 minutes after release.
* **Action:** Invalidate or pause all trade entries during active lockout windows.

### Gate 4: CoinGlass Liquidity Confluence
* **Source:** CoinGlass Liquidation Heatmaps, Funding Rates & Open Interest (OI).
* **Checks:**
  1. **Liquidation Target:** 1:3 Take-Profit target should align toward heavy liquidation pools (short liquidations for Longs, long liquidations for Shorts).
  2. **Invalidation Protection:** Stop-Loss must sit safely behind recent market structure sweeps to avoid stop hunts.
  3. **Funding Sentiment:** Avoid taking Longs when funding is critically overheated (+0.05%+); favor Longs when funding is deeply negative and OI surges (short squeeze).

---

## 2. Delta Exchange Execution Specification

All approved orders must be formatted with **Bracket Order parameters**:

```json
{
  "symbol": "BTC-PERP",
  "side": "buy",
  "order_type": "market_order",
  "size": 1,
  "bracket_stop_loss_price": "67200",
  "bracket_take_profit_price": "70400",
  "time_in_force": "gtc"
}
```

### Delta Exchange API Authentication (HMAC-SHA256):
* **Endpoint:** `POST /v2/orders`
* **Headers:**
  * `api-key`: Delta API Key
  * `timestamp`: Epoch seconds (string)
  * `signature`: `hex(HMAC_SHA256(api_secret, METHOD + TIMESTAMP + PATH + QUERY + BODY))`

---

## 3. Signal Processing Flow

When the user or TradingView sends a trade signal:
1. **News Check:** Is high-impact USD economic news pending? If YES $\to$ Halt & report lockout.
2. **Date Check:** Has UTC date rolled over? Read `daily_trades.json`. Count $< 3$? If NO $\to$ Reject with standby message.
3. **RRR & SL Check:** Is Stop-Loss valid? Calculate 1:3 Take-Profit.
4. **Liquidity Check:** Confirm liquidation confluence with CoinGlass.
5. **Execution Payload:** Output bracket order JSON and execute or log.
