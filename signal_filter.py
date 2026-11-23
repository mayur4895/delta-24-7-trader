"""
Delta Exchange Signal Filter & Execution Strategist Module
Strict constraints:
1. Max 3 trades per calendar day (UTC 00:00 - 23:59:59).
2. Mandatory Stop-Loss and fixed 1:2 or 1:3 Risk-to-Reward Ratio (RRR).
3. Delta Exchange Bracket Order and Webhook JSON formatting.
"""

import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, Optional

STATE_FILE = os.path.join(os.path.dirname(__file__), "daily_trades.json")
MAX_DAILY_TRADES = 3
DEFAULT_RRR = 3  # 1:3 default


def get_current_utc_date() -> str:
    """Returns the current date in UTC format YYYY-MM-DD."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_current_utc_timestamp() -> str:
    """Returns current UTC timestamp ISO-8601."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_trade_state() -> Dict[str, Any]:
    """Loads daily trade state from disk."""
    if not os.path.exists(STATE_FILE):
        return {"current_date": get_current_utc_date(), "trades_today": 0, "history": []}
    
    try:
        with open(STATE_FILE, "r") as f:
            data = json.load(f)
            # Reset if date has changed in UTC
            today = get_current_utc_date()
            if data.get("current_date") != today:
                data = {"current_date": today, "trades_today": 0, "history": []}
                save_trade_state(data)
            return data
    except Exception:
        return {"current_date": get_current_utc_date(), "trades_today": 0, "history": []}


def save_trade_state(state: Dict[str, Any]) -> None:
    """Saves daily trade state to disk."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def check_daily_limit() -> Tuple[bool, int, str]:
    """
    Checks if trading limit of 3 trades/day is active.
    Returns: (can_trade: bool, trades_done_today: int, current_date_utc: str)
    """
    state = load_trade_state()
    today = get_current_utc_date()
    
    # If date changed, reset counter
    if state.get("current_date") != today:
        state["current_date"] = today
        state["trades_today"] = 0
        state["history"] = []
        save_trade_state(state)
        
    trades_done = state.get("trades_today", 0)
    can_trade = trades_done < MAX_DAILY_TRADES
    return can_trade, trades_done, today


def calculate_bracket_targets(
    side: str,
    entry_price: float,
    stop_loss: float,
    rrr_multiplier: int = DEFAULT_RRR
) -> Tuple[float, float, float]:
    """
    Calculates 1R Risk distance and Take-Profit according to strict 1:2 or 1:3 RRR.
    Returns: (risk_distance, take_profit, calculated_rrr)
    """
    side = side.upper()
    if rrr_multiplier not in (2, 3):
        rrr_multiplier = DEFAULT_RRR

    if side in ("BUY", "LONG"):
        if stop_loss >= entry_price:
            raise ValueError(f"For LONG/BUY, Stop Loss ({stop_loss}) must be BELOW Entry Price ({entry_price}).")
        risk_distance = round(entry_price - stop_loss, 4)
        take_profit = round(entry_price + (risk_distance * rrr_multiplier), 4)
    elif side in ("SELL", "SHORT"):
        if stop_loss <= entry_price:
            raise ValueError(f"For SHORT/SELL, Stop Loss ({stop_loss}) must be ABOVE Entry Price ({entry_price}).")
        risk_distance = round(stop_loss - entry_price, 4)
        take_profit = round(entry_price - (risk_distance * rrr_multiplier), 4)
    else:
        raise ValueError(f"Invalid side '{side}'. Must be BUY/LONG or SELL/SHORT.")

    return risk_distance, take_profit, float(rrr_multiplier)


def generate_delta_exchange_payload(
    symbol: str,
    side: str,
    order_type: str,
    entry_price: float,
    stop_loss: float,
    take_profit: float,
    size: int = 1
) -> Dict[str, Any]:
    """
    Generates Delta Exchange API v2 / Webhook compatible bracket order payload.
    """
    action = "buy" if side.upper() in ("BUY", "LONG") else "sell"
    order_type_str = "market_order" if "MARKET" in order_type.upper() else "limit_order"

    payload = {
        "symbol": symbol.upper(),
        "side": action,
        "order_type": order_type_str,
        "size": size,
        "bracket_stop_loss_price": str(stop_loss),
        "bracket_take_profit_price": str(take_profit),
        "time_in_force": "gtc"
    }

    if order_type_str == "limit_order":
        payload["limit_price"] = str(entry_price)

    return payload


def process_signal(
    symbol: str,
    side: str,
    entry_price: float,
    stop_loss: Optional[float],
    take_profit: Optional[float] = None,
    order_type: str = "market",
    size: int = 1,
    rrr_preference: int = 3,
    commit_trade: bool = False
) -> Dict[str, Any]:
    """
    Main signal filtering gate:
    1. Checks UTC Daily limit (Max 3).
    2. Validates SL and calculates 1:2 or 1:3 TP.
    3. Builds Delta Exchange order payload.
    """
    utc_now = get_current_utc_timestamp()
    can_trade, trades_done, today_utc = check_daily_limit()

    # Rule 1: DAILY TRADE LIMIT
    if not can_trade:
        return {
            "status": "REJECTED",
            "reason": f"DAILY_LIMIT_EXCEEDED: {trades_done}/{MAX_DAILY_TRADES} trades completed for UTC date {today_utc}.",
            "trades_today": trades_done,
            "max_trades": MAX_DAILY_TRADES,
            "reset_time_utc": "00:00:00 UTC",
            "timestamp_utc": utc_now
        }

    # Rule 2: MANDATORY STOP LOSS CHECK
    if stop_loss is None or stop_loss <= 0:
        return {
            "status": "REJECTED",
            "reason": "MISSING_STOP_LOSS: Every signal must have a strictly defined invalidation / Stop-Loss price.",
            "timestamp_utc": utc_now
        }

    # Calculate or Verify RRR
    try:
        risk_dist, calculated_tp, rrr = calculate_bracket_targets(
            side=side,
            entry_price=entry_price,
            stop_loss=stop_loss,
            rrr_multiplier=rrr_preference
        )
    except ValueError as e:
        return {
            "status": "REJECTED",
            "reason": str(e),
            "timestamp_utc": utc_now
        }

    # If TP was passed in signal, verify it satisfies at least 1:2 or 1:3
    final_tp = calculated_tp
    if take_profit is not None and take_profit > 0:
        actual_reward = abs(take_profit - entry_price)
        actual_rrr = round(actual_reward / risk_dist, 2)
        if actual_rrr < 2.0:
            return {
                "status": "REJECTED",
                "reason": f"RRR_TOO_LOW: Provided TP yields {actual_rrr}:1, minimum required is 1:2 (default 1:3).",
                "timestamp_utc": utc_now
            }
        final_tp = take_profit
        rrr = actual_rrr

    # Rule 3: BUILD DELTA EXCHANGE PAYLOAD
    delta_payload = generate_delta_exchange_payload(
        symbol=symbol,
        side=side,
        order_type=order_type,
        entry_price=entry_price,
        stop_loss=stop_loss,
        take_profit=final_tp,
        size=size
    )

    trade_record = {
        "trade_number_today": trades_done + 1,
        "utc_date": today_utc,
        "symbol": symbol.upper(),
        "side": side.upper(),
        "order_type": order_type.upper(),
        "entry_price": entry_price,
        "stop_loss": stop_loss,
        "take_profit": final_tp,
        "risk_distance_1r": risk_dist,
        "rrr": f"1:{rrr}",
        "size": size,
        "timestamp_utc": utc_now
    }

    if commit_trade:
        state = load_trade_state()
        state["trades_today"] = trades_done + 1
        state.setdefault("history", []).append(trade_record)
        save_trade_state(state)

    return {
        "status": "APPROVED",
        "trade_number": trades_done + 1,
        "remaining_trades_today": MAX_DAILY_TRADES - (trades_done + 1 if commit_trade else trades_done),
        "trade_details": trade_record,
        "delta_exchange_payload": delta_payload,
        "timestamp_utc": utc_now
    }


if __name__ == "__main__":
    import sys

    # Quick self-test demonstration
    print(f"--- Delta Exchange Signal Filter Self-Test (UTC: {get_current_utc_timestamp()}) ---")
    can_trade, count, date = check_daily_limit()
    print(f"Status for UTC Date {date}: {count}/{MAX_DAILY_TRADES} trades used.")

    # Test signal: BTC-PERP Long
    sample_signal = process_signal(
        symbol="BTC-PERP",
        side="BUY",
        entry_price=68000.0,
        stop_loss=67200.0,
        rrr_preference=3,
        commit_trade=False
    )
    print("\nSample Signal Evaluation Result:")
    print(json.dumps(sample_signal, indent=2))
