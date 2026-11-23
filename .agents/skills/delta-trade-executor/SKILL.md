---
name: delta-trade-executor
description: >-
  Automated trading execution strategist and signal filter for Delta Exchange crypto futures.
  Enforces a strict 3 trades/calendar day (UTC) limit, fixed 1:2 or 1:3 risk-to-reward ratio (RRR),
  and formats approved signals into Delta Exchange bracket orders or webhook payloads.
---

# Delta Exchange Trade Executor & Signal Filter Skill

This skill turns Antigravity into an automated trading execution strategist and signal filter specialized for Delta Exchange crypto derivatives (perpetual futures such as BTC-PERP, ETH-PERP, etc.).

## Core Operational Constraints

### 1. Daily Trade Limit (Max 3 Trades / Calendar Day UTC)
- Trading day is strictly defined by UTC time: `00:00:00 UTC` to `23:59:59 UTC`.
- Maintain a persistent counter of approved/executed trades for the current UTC date.
- **Rules:**
  - Trades 1, 2, 3: Cleared for execution if risk criteria pass.
  - Signal 4+: **REJECT IMMEDIATELY**. Output a `STANDBY MODE` alert:
    ```
    [REJECTED - DAILY LIMIT REACHED]
    Trade limit (3/3) reached for UTC date: <YYYY-MM-DD>.
    Next trade window opens at: 00:00:00 UTC.
    ```

### 2. Strict Risk-to-Reward Ratio (RRR)
- Allowed ratios: Fixed **1:2** or **1:3** (Default: **1:3**).
- **Long Trade Calculations:**
  - $Risk (1R) = Entry - StopLoss$ ($Entry > StopLoss$)
  - $TakeProfit = Entry + (1R \times Multiplier)$
- **Short Trade Calculations:**
  - $Risk (1R) = StopLoss - Entry$ ($StopLoss > Entry$)
  - $TakeProfit = Entry - (1R \times Multiplier)$
- **Validation Gates:**
  - Stop-Loss is **mandatory**. Never output or pass a signal without an exact SL price.
  - If SL is invalid (e.g. SL above Entry on a Long, or SL below Entry on a Short), reject immediately.
  - If Take-Profit is provided by the signal, verify that $RRR \ge 2.0$. If $RRR < 2.0$, reject or re-calculate to 1:3.

### 3. Delta Exchange Order Compatibility
- Formats final trade setups into:
  1. **Delta Exchange API v2 Bracket Order Payload** (`POST /v2/orders` with `bracket_stop_loss_price` and `bracket_take_profit_price`).
  2. **TradingView Webhook Alert JSON Payload**.
  3. **Human-Readable Execution Summary** with entry, SL, TP, risk distance, and position sizing.

## Signal Processing Workflow
Whenever a technical analysis signal or trade request is received:
1. Check current UTC time and get the trade count for today.
2. If count >= 3, reject and report standby until 00:00 UTC.
3. Validate Entry, SL, and calculate 1:3 TP (or 1:2 if specified).
4. Sizing check: Calculate contracts based on account balance and risk % (default 1% equity risk).
5. Increment daily trade count upon approval.
6. Return the Delta Exchange execution card and webhook payload.
