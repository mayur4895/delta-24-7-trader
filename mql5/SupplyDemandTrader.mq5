//+------------------------------------------------------------------+
//|                                           SupplyDemandTrader.mq5 |
//|                                  Copyright 2026, Antigravity AI  |
//|                         https://www.mql5.com/en/users/antigravity|
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Antigravity AI"
#property link      "https://www.mql5.com"
#property version   "1.00"
#property description "Deterministic Institutional Supply & Demand Trend Continuation EA"
#property description "Strict closed-bar non-repainting evaluation for MT5 Strategy Tester"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>

//+------------------------------------------------------------------+
//| Enums                                                            |
//+------------------------------------------------------------------+
enum ENTRY_MODE
{
   ENTRY_NORMAL_CLOSE = 0, // Zone Touch + Closed Reversal Candle
   ENTRY_ENGULFING    = 1, // Zone Touch + Bullish/Bearish Engulfing
   ENTRY_LIMIT_ZONE   = 2  // Pending Limit Order at Zone Boundary/Midpoint
};

enum LIMIT_OFFSET_TYPE
{
   LIMIT_AT_ZONE_EDGE = 0, // Limit order exactly at zone high/low edge
   LIMIT_AT_MIDPOINT  = 1  // Limit order at 50% equilibrium midpoint of zone
};

enum ZONE_TYPE
{
   ZONE_DEMAND = 0,
   ZONE_SUPPLY = 1
};

enum TREND_STATE
{
   TREND_BULLISH = 1,
   TREND_BEARISH = -1,
   TREND_NEUTRAL = 0
};

//+------------------------------------------------------------------+
//| Data Structures                                                  |
//+------------------------------------------------------------------+
struct SwingPoint
{
   datetime time;
   double   price;
   int      barIndex;
   bool     isHigh;
};

struct SDZone
{
   ulong       id;
   ZONE_TYPE   type;
   datetime    formationTime;
   double      zoneHigh;
   double      zoneLow;
   double      impulseExtreme; // Leg High for Demand; Leg Low for Supply
   int         touchCount;
   bool        isActive;
   bool        isMitigated;
   string      chartObjName;
};

//+------------------------------------------------------------------+
//| Input Parameters                                                 |
//+------------------------------------------------------------------+
input group "=== 1. Market Structure & Trend Filter ==="
input int               SwingLookback          = 5;       // Swing Lookback Bars (N bars left & right)
input bool              OnlyTradeWithTrend     = true;    // Only Trade With Confirmed Trend (BoS)
input int               AtrPeriod              = 14;      // ATR Indicator Period

input group "=== 2. Supply & Demand Zone Detection ==="
input int               MinDisplacementCandles = 3;       // Min Consecutive Displacement Candles
input double            MinDisplacementATR     = 1.8;     // Min Displacement Size (Multiplier of ATR)
input bool              RequireFVG             = true;    // Require 3-Candle Fair Value Gap (Imbalance)
input bool              RequireBoS             = true;    // Require Displacement to Break Prior Swing
input int               MaxZoneTouches         = 1;       // Max Zone Touches Before Stale (Fresh Zones)
input int               MaxZoneAgeBars         = 300;     // Max Zone Age in Bars (Auto-Expire)
input bool              UseDiscountFilter      = false;   // Require Entry in Discount (<50%) / Premium (>50%)

input group "=== 3. Entry Models & Falling Knife Protection ==="
input ENTRY_MODE        EntryMode              = ENTRY_NORMAL_CLOSE; // Entry Trigger Mechanism
input LIMIT_OFFSET_TYPE LimitPlacement         = LIMIT_AT_ZONE_EDGE; // Pending Limit Position
input bool              AvoidFallingKnife      = true;    // Anti-Falling Knife Protection Toggle
input double            MaxApproachATR         = 2.2;     // Reject Entry If Approaching Candle > N * ATR

input group "=== 4. Risk Management & Position Sizing ==="
input double            RiskPercent            = 1.0;     // Risk Percentage per Trade (0 = use FixedLots)
input double            FixedLots              = 0.01;    // Fixed Lot Size (if RiskPercent = 0)
input double            RiskRewardRatio        = 3.0;     // Target Risk-Reward Ratio (e.g. 1:3)
input bool              UseRecentStructureTP   = false;   // Target Prior Swing High/Low If Meets MinRR
input double            MinStructureRR         = 2.0;     // Minimum RR required to use Structure TP
input int               SlBufferPoints         = 15;      // Stop Loss Buffer Beyond Zone (Points)
input int               MinSlPoints            = 30;      // Minimum SL Distance Clamp (Points)
input int               MaxSlPoints            = 500;     // Maximum SL Distance Clamp (Points, 0=no max)

input group "=== 5. Operational & Session Filters ==="
input ulong             MagicNumber            = 551001;  // EA Magic Number
input int               MaxOpenPositions       = 1;       // Maximum Concurrent Open Trades
input int               SpreadFilterPoints     = 40;      // Max Allowed Spread in Points (0=disabled)
input bool              UseSessionFilter       = false;   // Enable Trading Hours Session Window
input int               StartHour              = 7;       // Session Start Hour (Server Time)
input int               EndHour                = 20;      // Session End Hour (Server Time)
input bool              ShowZonesOnChart       = true;    // Visual Zone Rectangles on Chart

//+------------------------------------------------------------------+
//| Global Variables & Objects                                       |
//+------------------------------------------------------------------+
CTrade         m_trade;
CPositionInfo  m_position;
COrderInfo     m_order;

int            g_atrHandle      = INVALID_HANDLE;
datetime       g_lastBarTime    = 0;
ulong          g_zoneIdCounter  = 1;
SDZone         g_zones[];

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // Initialize ATR Indicator
   g_atrHandle = iATR(_Symbol, _Period, AtrPeriod);
   if(g_atrHandle == INVALID_HANDLE)
   {
      Print("[-] Failed to create ATR indicator handle. Error: ", GetLastError());
      return INIT_FAILED;
   }

   // Configure CTrade execution settings
   m_trade.SetExpertMagicNumber(MagicNumber);
   m_trade.SetDeviationInPoints(15);
   m_trade.SetTypeFillingBySymbol(_Symbol);

   ArrayResize(g_zones, 0);

   PrintFormat("[+] SupplyDemandTrader initialized successfully on %s %s. Magic: %d", 
               _Symbol, EnumToString(_Period), MagicNumber);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(g_atrHandle != INVALID_HANDLE)
   {
      IndicatorRelease(g_atrHandle);
   }

   if(ShowZonesOnChart)
   {
      ObjectsDeleteAll(0, "SDZ_");
   }

   PrintFormat("[*] SupplyDemandTrader deinitialized. Reason code: %d", reason);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Evaluate strictly once per newly opened bar to eliminate lookahead & intra-bar repainting
   if(!IsNewBar())
      return;

   // 1. Operational checks (Spread & Session)
   if(!IsTradingAllowed())
      return;

   // 2. Fetch latest closed bar rates & ATR
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copiedRates = CopyRates(_Symbol, _Period, 0, 500, rates);
   if(copiedRates < 100)
      return;

   double atrVal[];
   ArraySetAsSeries(atrVal, true);
   if(CopyBuffer(g_atrHandle, 0, 0, 50, atrVal) < 10)
      return;

   double currentATR = atrVal[1]; // Shift 1: Completed bar ATR

   // 3. Scan & Update Market Structure (Swings, Trend & BoS)
   TREND_STATE currentTrend = DetectMarketStructure(rates, copiedRates);

   // 4. Invalidate Stale / Breached Zones ("Dead Zones")
   UpdateAndCleanZones(rates, copiedRates);

   // 5. Detect New Supply & Demand Formations on closed bar 1
   ScanNewZones(rates, copiedRates, currentATR, currentTrend);

   // 6. Manage Pending Orders & Active Position Limits
   int activePositions = GetOpenPositionsCount();
   int activeOrders    = GetOpenOrdersCount();

   if(activePositions >= MaxOpenPositions)
      return;

   // 7. Check Retest & Generate Entry Signals
   EvaluateZoneEntries(rates, currentATR, currentTrend, activePositions, activeOrders);
}

//+------------------------------------------------------------------+
//| Detect New Bar Opening (Strict Shift >= 1)                       |
//+------------------------------------------------------------------+
bool IsNewBar()
{
   datetime currentBarTime = iTime(_Symbol, _Period, 0);
   if(currentBarTime != g_lastBarTime)
   {
      g_lastBarTime = currentBarTime;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Spread & Session Time Filters                                    |
//+------------------------------------------------------------------+
bool IsTradingAllowed()
{
   // Spread Filter
   if(SpreadFilterPoints > 0)
   {
      long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
      if(spread > SpreadFilterPoints)
         return false;
   }

   // Session Filter
   if(UseSessionFilter)
   {
      MqlDateTime dt;
      TimeCurrent(dt);
      if(StartHour <= EndHour)
      {
         if(dt.hour < StartHour || dt.hour >= EndHour)
            return false;
      }
      else // Overnight cross
      {
         if(dt.hour < StartHour && dt.hour >= EndHour)
            return false;
      }
   }

   return true;
}

//+------------------------------------------------------------------+
//| Detect Market Structure (Swings & Trend State)                   |
//+------------------------------------------------------------------+
TREND_STATE DetectMarketStructure(const MqlRates &rates[], int totalBars)
{
   SwingPoint swingHighs[];
   SwingPoint swingLows[];
   ArrayResize(swingHighs, 0);
   ArrayResize(swingLows, 0);

   // Search for swings on confirmed closed bars (shift 1 onwards)
   // A swing at index k requires SwingLookback bars to its left and right
   int startBar = SwingLookback + 1;
   int endBar   = MathMin(totalBars - SwingLookback - 1, 200);

   for(int k = startBar; k <= endBar; k++)
   {
      bool isHigh = true;
      bool isLow  = true;

      for(int j = 1; j <= SwingLookback; j++)
      {
         if(rates[k].high <= rates[k - j].high || rates[k].high <= rates[k + j].high)
            isHigh = false;
         if(rates[k].low >= rates[k - j].low || rates[k].low >= rates[k + j].low)
            isLow = false;
      }

      if(isHigh)
      {
         int sz = ArraySize(swingHighs);
         ArrayResize(swingHighs, sz + 1);
         swingHighs[sz].time     = rates[k].time;
         swingHighs[sz].price    = rates[k].high;
         swingHighs[sz].barIndex = k;
         swingHighs[sz].isHigh   = true;
      }

      if(isLow)
      {
         int sz = ArraySize(swingLows);
         ArrayResize(swingLows, sz + 1);
         swingLows[sz].time     = rates[k].time;
         swingLows[sz].price    = rates[k].low;
         swingLows[sz].barIndex = k;
         swingLows[sz].isHigh   = false;
      }
   }

   if(ArraySize(swingHighs) < 2 || ArraySize(swingLows) < 2)
      return TREND_NEUTRAL;

   // Check rising / falling structure
   bool higherHighs = (swingHighs[0].price > swingHighs[1].price);
   bool higherLows  = (swingLows[0].price > swingLows[1].price);
   bool lowerHighs  = (swingHighs[0].price < swingHighs[1].price);
   bool lowerLows   = (swingLows[0].price < swingLows[1].price);

   // Bullish Trend: Rising swings + Closed candle broke above prior swing high (BoS)
   if(higherHighs && higherLows && (rates[1].close > swingHighs[1].price))
      return TREND_BULLISH;

   // Bearish Trend: Falling swings + Closed candle broke below prior swing low (BoS)
   if(lowerHighs && lowerLows && (rates[1].close < swingLows[1].price))
      return TREND_BEARISH;

   if(higherHighs && higherLows) return TREND_BULLISH;
   if(lowerHighs && lowerLows)   return TREND_BEARISH;

   return TREND_NEUTRAL;
}

//+------------------------------------------------------------------+
//| Scan for Fresh Supply & Demand Formations                        |
//+------------------------------------------------------------------+
void ScanNewZones(const MqlRates &rates[], int totalBars, double atr, TREND_STATE trend)
{
   // Evaluate bar 1 as the completion of displacement
   // Origin candle index = 1 + MinDisplacementCandles
   int originIdx = 1 + MinDisplacementCandles;
   if(originIdx + 2 >= totalBars)
      return;

   datetime originTime = rates[originIdx].time;

   // Ensure this formation hasn't already been cataloged
   for(int z = 0; z < ArraySize(g_zones); z++)
   {
      if(g_zones[z].formationTime == originTime)
         return;
   }

   // ----------------------------------------------------------------
   // 1. BULLISH DEMAND ZONE EVALUATION
   // ----------------------------------------------------------------
   // Origin must be a bearish candle
   if(rates[originIdx].close < rates[originIdx].open)
   {
      bool allDisplacementBullish = true;
      double displacementStart = rates[originIdx].low;
      double displacementEnd   = rates[1].high;

      for(int c = 1; c <= MinDisplacementCandles; c++)
      {
         int bar = originIdx - c;
         if(rates[bar].close <= rates[bar].open)
         {
            allDisplacementBullish = false;
            break;
         }
      }

      double totalMove = rates[1].close - rates[originIdx].low;

      if(allDisplacementBullish && (totalMove >= MinDisplacementATR * atr))
      {
         bool fvgValid = true;
         if(RequireFVG)
         {
            // 3-candle FVG: Gap between candle 3 low and candle 1 high
            // Candle 1: originIdx; Candle 3: originIdx - 2
            fvgValid = (rates[originIdx - 2].low > rates[originIdx].high);
         }

         bool bosValid = true;
         if(RequireBoS)
         {
            bosValid = (rates[1].close > rates[originIdx].high + (atr * 0.5));
         }

         if(fvgValid && bosValid)
         {
            SDZone newZone;
            newZone.id             = g_zoneIdCounter++;
            newZone.type           = ZONE_DEMAND;
            newZone.formationTime  = originTime;
            newZone.zoneHigh       = rates[originIdx].high;
            newZone.zoneLow        = rates[originIdx].low;
            newZone.impulseExtreme = rates[1].high; // Leg High
            newZone.touchCount     = 0;
            newZone.isActive       = true;
            newZone.isMitigated    = false;
            newZone.chartObjName   = StringFormat("SDZ_Demand_%d", newZone.id);

            int sz = ArraySize(g_zones);
            ArrayResize(g_zones, sz + 1);
            g_zones[sz] = newZone;

            if(ShowZonesOnChart)
               DrawZoneRectangle(newZone, rates[1].time);

            PrintFormat("[+] New Demand Zone #%d identified at [%.2f - %.2f] on %s", 
                        newZone.id, newZone.zoneLow, newZone.zoneHigh, TimeToString(originTime));
         }
      }
   }

   // ----------------------------------------------------------------
   // 2. BEARISH SUPPLY ZONE EVALUATION
   // ----------------------------------------------------------------
   // Origin must be a bullish candle
   if(rates[originIdx].close > rates[originIdx].open)
   {
      bool allDisplacementBearish = true;

      for(int c = 1; c <= MinDisplacementCandles; c++)
      {
         int bar = originIdx - c;
         if(rates[bar].close >= rates[bar].open)
         {
            allDisplacementBearish = false;
            break;
         }
      }

      double totalMove = rates[originIdx].high - rates[1].close;

      if(allDisplacementBearish && (totalMove >= MinDisplacementATR * atr))
      {
         bool fvgValid = true;
         if(RequireFVG)
         {
            // 3-candle Bearish FVG: Gap between candle 1 low and candle 3 high
            fvgValid = (rates[originIdx - 2].high < rates[originIdx].low);
         }

         bool bosValid = true;
         if(RequireBoS)
         {
            bosValid = (rates[1].close < rates[originIdx].low - (atr * 0.5));
         }

         if(fvgValid && bosValid)
         {
            SDZone newZone;
            newZone.id             = g_zoneIdCounter++;
            newZone.type           = ZONE_SUPPLY;
            newZone.formationTime  = originTime;
            newZone.zoneHigh       = rates[originIdx].high;
            newZone.zoneLow        = rates[originIdx].low;
            newZone.impulseExtreme = rates[1].low; // Leg Low
            newZone.touchCount     = 0;
            newZone.isActive       = true;
            newZone.isMitigated    = false;
            newZone.chartObjName   = StringFormat("SDZ_Supply_%d", newZone.id);

            int sz = ArraySize(g_zones);
            ArrayResize(g_zones, sz + 1);
            g_zones[sz] = newZone;

            if(ShowZonesOnChart)
               DrawZoneRectangle(newZone, rates[1].time);

            PrintFormat("[+] New Supply Zone #%d identified at [%.2f - %.2f] on %s", 
                        newZone.id, newZone.zoneLow, newZone.zoneHigh, TimeToString(originTime));
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Invalidate Dead / Breached / Expired Zones                       |
//+------------------------------------------------------------------+
void UpdateAndCleanZones(const MqlRates &rates[], int totalBars)
{
   datetime currentBarTime = rates[1].time;

   for(int z = 0; z < ArraySize(g_zones); z++)
   {
      if(!g_zones[z].isActive)
         continue;

      // 1. Age Expiration Check
      int ageInBars = iBarShift(_Symbol, _Period, g_zones[z].formationTime);
      if(ageInBars > MaxZoneAgeBars)
      {
         g_zones[z].isActive = false;
         if(ShowZonesOnChart)
            ObjectSetInteger(0, g_zones[z].chartObjName, OBJPROP_COLOR, clrDimGray);
         continue;
      }

      // 2. Dead Zone Breach Invalidation
      if(g_zones[z].type == ZONE_DEMAND)
      {
         // Closed candle broke below Demand Zone floor
         if(rates[1].close < g_zones[z].zoneLow)
         {
            g_zones[z].isActive = false;
            if(ShowZonesOnChart)
               ObjectSetInteger(0, g_zones[z].chartObjName, OBJPROP_COLOR, clrDarkSlateGray);
            continue;
         }
      }
      else if(g_zones[z].type == ZONE_SUPPLY)
      {
         // Closed candle broke above Supply Zone ceiling
         if(rates[1].close > g_zones[z].zoneHigh)
         {
            g_zones[z].isActive = false;
            if(ShowZonesOnChart)
               ObjectSetInteger(0, g_zones[z].chartObjName, OBJPROP_COLOR, clrDarkSlateGray);
            continue;
         }
      }

      // Update right coordinate on visual chart
      if(ShowZonesOnChart)
      {
         ObjectSetInteger(0, g_zones[z].chartObjName, OBJPROP_TIME, 1, currentBarTime);
      }
   }
}

//+------------------------------------------------------------------+
//| Evaluate Zone Retests and Execute Entries                        |
//+------------------------------------------------------------------+
void EvaluateZoneEntries(const MqlRates &rates[], double atr, TREND_STATE trend, 
                         int activePositions, int activeOrders)
{
   for(int z = ArraySize(g_zones) - 1; z >= 0; z--)
   {
      if(!g_zones[z].isActive || g_zones[z].isMitigated)
         continue;

      // Filter: Trade only with confirmed market structure trend
      if(OnlyTradeWithTrend)
      {
         if(g_zones[z].type == ZONE_DEMAND && trend != TREND_BULLISH)
            continue;
         if(g_zones[z].type == ZONE_SUPPLY && trend != TREND_BEARISH)
            continue;
      }

      // Filter: Discount / Premium check
      if(UseDiscountFilter)
      {
         if(g_zones[z].type == ZONE_DEMAND)
         {
            double equilibrium = (g_zones[z].impulseExtreme + g_zones[z].zoneLow) * 0.5;
            if(rates[1].close > equilibrium)
               continue; // Not in discount (<50%)
         }
         else if(g_zones[z].type == ZONE_SUPPLY)
         {
            double equilibrium = (g_zones[z].zoneHigh + g_zones[z].impulseExtreme) * 0.5;
            if(rates[1].close < equilibrium)
               continue; // Not in premium (>50%)
         }
      }

      // Filter: Anti-Falling Knife Protection
      if(AvoidFallingKnife)
      {
         double lastCandleRange = MathAbs(rates[1].close - rates[1].open);
         if(g_zones[z].type == ZONE_DEMAND && (rates[1].close < rates[1].open))
         {
            if(lastCandleRange > MaxApproachATR * atr)
               continue; // Massive red dump approaching demand
         }
         else if(g_zones[z].type == ZONE_SUPPLY && (rates[1].close > rates[1].open))
         {
            if(lastCandleRange > MaxApproachATR * atr)
               continue; // Massive green rocket approaching supply
         }
      }

      // -------------------------------------------------------------
      // DEMAND ZONE BUY RETEST
      // -------------------------------------------------------------
      if(g_zones[z].type == ZONE_DEMAND)
      {
         bool enteredZone = (rates[1].low <= g_zones[z].zoneHigh && rates[1].high >= g_zones[z].zoneLow);
         if(!enteredZone && EntryMode != ENTRY_LIMIT_ZONE)
            continue;

         bool signalTriggered = false;

         if(EntryMode == ENTRY_NORMAL_CLOSE)
         {
            // Closed back in trade direction (green/neutral candle above zone low)
            signalTriggered = (enteredZone && rates[1].close >= rates[1].open && rates[1].close > g_zones[z].zoneLow);
         }
         else if(EntryMode == ENTRY_ENGULFING)
         {
            // Bullish engulfing candle on shift 1
            bool isBullish = (rates[1].close > rates[1].open);
            bool wasBearish = (rates[2].close < rates[2].open);
            bool engulfs = (rates[1].close >= rates[2].open && rates[1].open <= rates[2].close);
            signalTriggered = (enteredZone && isBullish && wasBearish && engulfs);
         }
         else if(EntryMode == ENTRY_LIMIT_ZONE)
         {
            if(activeOrders == 0)
            {
               PlaceLimitOrder(ORDER_TYPE_BUY_LIMIT, g_zones[z], atr);
            }
            continue;
         }

         if(signalTriggered)
         {
            g_zones[z].touchCount++;
            if(g_zones[z].touchCount >= MaxZoneTouches)
               g_zones[z].isMitigated = true;

            ExecuteMarketEntry(ORDER_TYPE_BUY, g_zones[z], rates[1].close, atr);
            break;
         }
      }

      // -------------------------------------------------------------
      // SUPPLY ZONE SELL RETEST
      // -------------------------------------------------------------
      else if(g_zones[z].type == ZONE_SUPPLY)
      {
         bool enteredZone = (rates[1].high >= g_zones[z].zoneLow && rates[1].low <= g_zones[z].zoneHigh);
         if(!enteredZone && EntryMode != ENTRY_LIMIT_ZONE)
            continue;

         bool signalTriggered = false;

         if(EntryMode == ENTRY_NORMAL_CLOSE)
         {
            // Closed back in trade direction (red/neutral candle below zone high)
            signalTriggered = (enteredZone && rates[1].close <= rates[1].open && rates[1].close < g_zones[z].zoneHigh);
         }
         else if(EntryMode == ENTRY_ENGULFING)
         {
            // Bearish engulfing candle on shift 1
            bool isBearish = (rates[1].close < rates[1].open);
            bool wasBullish = (rates[2].close > rates[2].open);
            bool engulfs = (rates[1].close <= rates[2].open && rates[1].open >= rates[2].close);
            signalTriggered = (enteredZone && isBearish && wasBullish && engulfs);
         }
         else if(EntryMode == ENTRY_LIMIT_ZONE)
         {
            if(activeOrders == 0)
            {
               PlaceLimitOrder(ORDER_TYPE_SELL_LIMIT, g_zones[z], atr);
            }
            continue;
         }

         if(signalTriggered)
         {
            g_zones[z].touchCount++;
            if(g_zones[z].touchCount >= MaxZoneTouches)
               g_zones[z].isMitigated = true;

            ExecuteMarketEntry(ORDER_TYPE_SELL, g_zones[z], rates[1].close, atr);
            break;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Execute Instant Market Entry with 1:3 RRR & Risk Management      |
//+------------------------------------------------------------------+
void ExecuteMarketEntry(ENUM_ORDER_TYPE orderType, const SDZone &zone, double triggerPrice, double atr)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   double entryPrice = (orderType == ORDER_TYPE_BUY) ? ask : bid;
   double stopLoss = 0.0;
   double takeProfit = 0.0;

   // 1. Calculate Stop Loss beyond zone boundary with buffer
   if(orderType == ORDER_TYPE_BUY)
   {
      stopLoss = zone.zoneLow - (SlBufferPoints * point);
   }
   else
   {
      stopLoss = zone.zoneHigh + (SlBufferPoints * point);
   }

   // 2. SL Distance & Clamping
   double slDistancePoints = MathAbs(entryPrice - stopLoss) / point;
   if(MinSlPoints > 0 && slDistancePoints < MinSlPoints)
   {
      slDistancePoints = MinSlPoints;
      stopLoss = (orderType == ORDER_TYPE_BUY) ? entryPrice - (MinSlPoints * point) : entryPrice + (MinSlPoints * point);
   }
   if(MaxSlPoints > 0 && slDistancePoints > MaxSlPoints)
   {
      PrintFormat("[-] Trade skipped: SL distance (%d points) exceeds MaxSlPoints (%d).", 
                  (int)slDistancePoints, MaxSlPoints);
      return;
   }

   // 3. Take Profit Calculation (1:3 RRR or Recent Structure)
   double slDistancePrice = MathAbs(entryPrice - stopLoss);
   takeProfit = (orderType == ORDER_TYPE_BUY) ? entryPrice + (slDistancePrice * RiskRewardRatio) 
                                              : entryPrice - (slDistancePrice * RiskRewardRatio);

   if(UseRecentStructureTP)
   {
      double structureTarget = zone.impulseExtreme;
      double structureReward = MathAbs(structureTarget - entryPrice);
      if(slDistancePrice > 0 && (structureReward / slDistancePrice >= MinStructureRR))
      {
         takeProfit = structureTarget;
      }
   }

   // 4. Position Sizing
   double lots = CalculateLotSize(slDistancePoints);

   entryPrice = NormalizeDouble(entryPrice, _Digits);
   stopLoss   = NormalizeDouble(stopLoss, _Digits);
   takeProfit = NormalizeDouble(takeProfit, _Digits);

   // 5. Send Order
   string comment = StringFormat("SD #%d RRR 1:%.1f", zone.id, RiskRewardRatio);
   if(m_trade.PositionOpen(_Symbol, orderType, lots, entryPrice, stopLoss, takeProfit, comment))
   {
      PrintFormat("[✓] Market Order executed: %s %.2f lots @ %.2f | SL: %.2f | TP: %.2f",
                  EnumToString(orderType), lots, entryPrice, stopLoss, takeProfit);
   }
   else
   {
      PrintFormat("[-] PositionOpen failed. Error: %d - %s", 
                  m_trade.ResultRetcode(), m_trade.ResultComment());
   }
}

//+------------------------------------------------------------------+
//| Place Pending Limit Orders at Zone Boundaries                    |
//+------------------------------------------------------------------+
void PlaceLimitOrder(ENUM_ORDER_TYPE orderType, const SDZone &zone, double atr)
{
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double limitPrice = 0.0;
   double stopLoss   = 0.0;
   double takeProfit = 0.0;

   if(orderType == ORDER_TYPE_BUY_LIMIT)
   {
      limitPrice = (LimitPlacement == LIMIT_AT_ZONE_EDGE) ? zone.zoneHigh : (zone.zoneHigh + zone.zoneLow) * 0.5;
      stopLoss   = zone.zoneLow - (SlBufferPoints * point);
   }
   else
   {
      limitPrice = (LimitPlacement == LIMIT_AT_ZONE_EDGE) ? zone.zoneLow : (zone.zoneHigh + zone.zoneLow) * 0.5;
      stopLoss   = zone.zoneHigh + (SlBufferPoints * point);
   }

   double slDistancePoints = MathAbs(limitPrice - stopLoss) / point;
   if(MinSlPoints > 0 && slDistancePoints < MinSlPoints)
   {
      slDistancePoints = MinSlPoints;
      stopLoss = (orderType == ORDER_TYPE_BUY_LIMIT) ? limitPrice - (MinSlPoints * point) : limitPrice + (MinSlPoints * point);
   }

   double slDistPrice = MathAbs(limitPrice - stopLoss);
   takeProfit = (orderType == ORDER_TYPE_BUY_LIMIT) ? limitPrice + (slDistPrice * RiskRewardRatio)
                                                    : limitPrice - (slDistPrice * RiskRewardRatio);

   double lots = CalculateLotSize(slDistancePoints);

   limitPrice = NormalizeDouble(limitPrice, _Digits);
   stopLoss   = NormalizeDouble(stopLoss, _Digits);
   takeProfit = NormalizeDouble(takeProfit, _Digits);

   string comment = StringFormat("SD Limit #%d", zone.id);
   m_trade.OrderOpen(_Symbol, orderType, lots, 0.0, limitPrice, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment);
}

//+------------------------------------------------------------------+
//| Calculate Lot Size Based on Account Balance Risk % or Fixed Lots |
//+------------------------------------------------------------------+
double CalculateLotSize(double slDistancePoints)
{
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

   if(RiskPercent <= 0.0)
   {
      double lots = MathFloor(FixedLots / lotStep) * lotStep;
      return MathMax(minLot, MathMin(maxLot, lots));
   }

   double balance     = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney   = balance * (RiskPercent / 100.0);
   double tickValue   = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize    = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double point       = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   if(tickSize <= 0.0 || slDistancePoints <= 0.0)
      return minLot;

   double moneyPerPointPerLot = (tickValue / tickSize) * point;
   double calculatedLots = riskMoney / (slDistancePoints * moneyPerPointPerLot);

   calculatedLots = MathFloor(calculatedLots / lotStep) * lotStep;

   // Safety Margin Check for Low Capital Accounts
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double marginRequired = 0.0;
   if(OrderCalcMargin(ORDER_TYPE_BUY, _Symbol, (calculatedLots > 0 ? calculatedLots : minLot), SymbolInfoDouble(_Symbol, SYMBOL_ASK), marginRequired))
   {
      if(marginRequired > freeMargin && marginRequired > 0.0)
      {
         // Capital is low: Scale down lots to keep margin within 70% of available free margin
         double unitMargin = marginRequired / (calculatedLots > 0 ? calculatedLots : minLot);
         double maxSafeLots = (freeMargin * 0.70) / unitMargin;
         calculatedLots = MathFloor(maxSafeLots / lotStep) * lotStep;
         PrintFormat("[!] Low Capital Alert: Scaled lots to %.2f to fit free margin ($%.2f).", calculatedLots, freeMargin);
      }
   }

   return MathMax(minLot, MathMin(maxLot, calculatedLots));
}

//+------------------------------------------------------------------+
//| Helper Counts for Magic Number Positions & Orders                |
//+------------------------------------------------------------------+
int GetOpenPositionsCount()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_position.SelectByIndex(i))
      {
         if(m_position.Symbol() == _Symbol && m_position.Magic() == MagicNumber)
            count++;
      }
   }
   return count;
}

int GetOpenOrdersCount()
{
   int count = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(m_order.SelectByIndex(i))
      {
         if(m_order.Symbol() == _Symbol && m_order.Magic() == MagicNumber)
            count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Draw Visual Zone Rectangles on Chart                             |
//+------------------------------------------------------------------+
void DrawZoneRectangle(const SDZone &zone, datetime currentTime)
{
   if(!ShowZonesOnChart)
      return;

   color zoneColor = (zone.type == ZONE_DEMAND) ? clrMediumSeaGreen : clrIndianRed;

   ObjectCreate(0, zone.chartObjName, OBJ_RECTANGLE, 0, zone.formationTime, zone.zoneHigh, currentTime, zone.zoneLow);
   ObjectSetInteger(0, zone.chartObjName, OBJPROP_COLOR, zoneColor);
   ObjectSetInteger(0, zone.chartObjName, OBJPROP_FILL, true);
   ObjectSetInteger(0, zone.chartObjName, OBJPROP_BACK, true);
   ObjectSetInteger(0, zone.chartObjName, OBJPROP_SELECTABLE, false);
}
//+------------------------------------------------------------------+
