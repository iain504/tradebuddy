//+------------------------------------------------------------------+
//|  TradeBuddyAgent.mq5                                             |
//|  Push agent for TradeBuddy (self-hosted MT4/MT5 account monitor) |
//|                                                                  |
//|  Runs INSIDE your MT5 terminal (Windows, or Wine) and pushes:    |
//|    - account balance/equity/margin snapshots                     |
//|    - currently open positions                                    |
//|    - closed trade history (deals grouped by position id)         |
//|  to the dashboard's /api/ingest endpoint.                        |
//|                                                                  |
//|  SETUP (one time):                                               |
//|   1. Copy this file to <MT5 Data Folder>/MQL5/Experts            |
//|      (MT5 menu: File -> Open Data Folder), compile in MetaEditor |
//|      (F7).                                                       |
//|   2. MT5: Tools -> Options -> Expert Advisors -> tick            |
//|      "Allow WebRequest for listed URL" and add the dashboard     |
//|      base URL (e.g. https://tradebuddy.example.com).             |
//|   3. Add the account in the TradeBuddy dashboard (same login +   |
//|      broker server, investor password).                          |
//|   4. Attach this EA to any chart and fill IngestURL/IngestToken  |
//|      (values are shown in the dashboard's "Setup guide").        |
//|                                                                  |
//|  Read-only: the EA never trades. AutoTrading is NOT required.    |
//|  Data is deduplicated server-side by (login, positionId).        |
//+------------------------------------------------------------------+
#property copyright "TradeBuddy"
#property link      "https://github.com/iain504/tradebuddy"
#property version   "1.00"
#property description "Pushes your MT5 account snapshots and trade history to a TradeBuddy dashboard."

input string IngestURL      = "http://localhost:3000/api/ingest"; // TradeBuddy ingest endpoint
input string IngestToken    = "";                                  // X-Ingest-Token value
input int    PollSeconds    = 30;     // Seconds between pushes
input int    HistoryBatch   = 200;    // Closed trades sent per request
input int    TimeoutMs      = 10000;  // WebRequest timeout (ms)
input int    RescanMinutes  = 5;      // Re-check for newly closed trades every N minutes
input int    GraceDays      = 30;     // Overlap window when re-scanning for closed deals
input bool   RestartHistory = false;  // Re-send full history once (ignores saved progress)
input bool   VerboseLogs    = false;  // Log every successful push

// --- aggregated closed position ---------------------------------- //
struct ClosedPos
{
   long     posId;
   string   symbol;
   string   side;
   double   volume;
   double   openPrice;
   double   closePrice;
   datetime openTime;
   datetime closeTime;
   double   profit;
   double   commission;
   double   swap;
   string   comment;
};

// --- state ------------------------------------------------------- //
datetime g_cursorTime   = 0;      // history pagination cursor (close time)
long     g_cursorPos    = 0;      // history pagination cursor (position id tiebreak)
long     g_login        = 0;      // account the cursor belongs to
bool     g_historyDone  = false;
datetime g_nextScan     = 0;
int      g_failStreak   = 0;
string   g_lastError    = "";
datetime g_lastPushOk   = 0;
bool     g_firstTick    = true;

//+------------------------------------------------------------------+
//| Small helpers                                                    |
//+------------------------------------------------------------------+
string TBTrim(string s)
{
   int a = 0, b = StringLen(s) - 1;
   while(a <= b && StringGetCharacter(s, a) == ' ') a++;
   while(b >= a && StringGetCharacter(s, b) == ' ') b--;
   if(b < a) return "";
   return StringSubstr(s, a, b - a + 1);
}

string JsonEscape(string s)
{
   string outp = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '\\')           outp = outp + "\\\\";
      else if(c == '"')       outp = outp + "\\\"";
      else if(c == '\n' || c == '\r' || c == '\t') outp = outp + " ";
      else if(c < 32 || c > 126) outp = outp + "?";
      else                    outp = outp + ShortToString(c);
   }
   return outp;
}

string IsoTime(datetime t)
{
   if(t <= 0) return "1970-01-01T00:00:00Z";
   MqlDateTime st;
   TimeToStruct(t, st);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       st.year, st.mon, st.day, st.hour, st.min, st.sec);
}

string FmtMoney(double v) { return DoubleToString(v, 2); }

string FmtPrice(string symbol, double v)
{
   int digits = 5;
   if(StringLen(symbol) > 0)
   {
      int d = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      if(d > 0) digits = d;
   }
   return DoubleToString(v, digits);
}

//+------------------------------------------------------------------+
//| WebRequest wrapper                                               |
//+------------------------------------------------------------------+
bool HttpPostJson(string body, string &response, int &status)
{
   char   data[];
   char   result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   if(StringLen(IngestToken) > 0)
      headers = headers + "X-Ingest-Token: " + IngestToken + "\r\n";

   ResetLastError();
   int copied = StringToCharArray(body, data, 0, StringLen(body));
   if(copied <= 0)
   {
      Print("TradeBuddy: failed to encode request body");
      return false;
   }

   status = WebRequest("POST", IngestURL, headers, TimeoutMs, data, result, resultHeaders);
   if(status == -1)
   {
      int errCode = GetLastError();
      Print("TradeBuddy: WebRequest failed (error ", errCode,
            "). If this keeps happening: MT5 -> Tools -> Options -> Expert Advisors -> ",
            "tick 'Allow WebRequest for listed URL' and add the dashboard base URL.");
      return false;
   }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

//+------------------------------------------------------------------+
//| Open positions                                                   |
//+------------------------------------------------------------------+
string PositionsJson()
{
   string arr = "";
   int count = 0;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      long ptype = PositionGetInteger(POSITION_TYPE);
      if(count > 0) arr = arr + ",";
      string symbol = PositionGetString(POSITION_SYMBOL);
      arr = arr + "{"
         + "\"positionId\":\"" + IntegerToString((long)PositionGetInteger(POSITION_IDENTIFIER)) + "\","
         + "\"symbol\":\"" + JsonEscape(symbol) + "\","
         + "\"side\":\"" + (ptype == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\","
         + "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ","
         + "\"openPrice\":" + FmtPrice(symbol, PositionGetDouble(POSITION_PRICE_OPEN)) + ","
         + "\"currentPrice\":" + FmtPrice(symbol, PositionGetDouble(POSITION_PRICE_CURRENT)) + ","
         + "\"openTime\":\"" + IsoTime((datetime)PositionGetInteger(POSITION_TIME)) + "\","
         + "\"profit\":" + FmtMoney(PositionGetDouble(POSITION_PROFIT)) + ","
         + "\"swap\":" + FmtMoney(PositionGetDouble(POSITION_SWAP))
         + "}";
      count++;
   }
   return "[" + arr + "]";
}

//+------------------------------------------------------------------+
//| Aggregate one position's deals (HistorySelectByPosition done by  |
//| the caller). Returns false when the position is not fully closed.|
//+------------------------------------------------------------------+
bool AggregateSelectedPosition(long posId, ClosedPos &out)
{
   int deals = HistoryDealsTotal();
   if(deals <= 0) return false;

   double vin = 0, vout = 0, pin = 0, pout = 0;
   double profit = 0, swap = 0, comm = 0;
   datetime tIn = 0, tOut = 0;
   string symbol = "", comment = "";
   long side = -1;

   for(int i = 0; i < deals; i++)
   {
      ulong dticket = HistoryDealGetTicket(i);
      if(dticket == 0) continue;
      long dtype = HistoryDealGetInteger(dticket, DEAL_TYPE);
      if(dtype == DEAL_TYPE_BALANCE || dtype == DEAL_TYPE_CREDIT) continue;

      double vol   = HistoryDealGetDouble(dticket, DEAL_VOLUME);
      double price = HistoryDealGetDouble(dticket, DEAL_PRICE);
      profit += HistoryDealGetDouble(dticket, DEAL_PROFIT);
      swap   += HistoryDealGetDouble(dticket, DEAL_SWAP);
      comm   += HistoryDealGetDouble(dticket, DEAL_COMMISSION);
      if(StringLen(symbol) == 0) symbol = HistoryDealGetString(dticket, DEAL_SYMBOL);
      if(StringLen(comment) == 0) comment = HistoryDealGetString(dticket, DEAL_COMMENT);

      long entry = HistoryDealGetInteger(dticket, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_IN || entry == DEAL_ENTRY_INOUT)
      {
         vin += vol;
         pin += price * vol;
         if(tIn == 0) tIn = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
         if(side == -1) side = dtype;
      }
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
      {
         vout += vol;
         pout += price * vol;
         datetime dt = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
         if(dt >= tOut) tOut = dt;
      }
   }

   // Only fully closed positions become trades (open ones arrive via /positions).
   if(vin <= 0.0 || vout <= 0.0 || MathAbs(vin - vout) > 1e-6) return false;

   out.posId      = posId;
   out.symbol     = symbol;
   out.side       = (side == DEAL_TYPE_SELL) ? "SELL" : "BUY";
   out.volume     = vin;
   out.openPrice  = (vin  > 0.0) ? pin / vin  : 0.0;
   out.closePrice = (vout > 0.0) ? pout / vout : 0.0;
   out.openTime   = tIn;
   out.closeTime  = tOut;
   out.profit     = profit;
   out.commission = comm;
   out.swap       = swap;
   out.comment    = comment;
   return true;
}

string ClosedTradeJson(ClosedPos &p)
{
   return "{"
      + "\"positionId\":\"" + IntegerToString(p.posId) + "\","
      + "\"symbol\":\"" + JsonEscape(p.symbol) + "\","
      + "\"side\":\"" + p.side + "\","
      + "\"volume\":" + DoubleToString(p.volume, 2) + ","
      + "\"openPrice\":" + FmtPrice(p.symbol, p.openPrice) + ","
      + "\"closePrice\":" + FmtPrice(p.symbol, p.closePrice) + ","
      + "\"openTime\":\"" + IsoTime(p.openTime) + "\","
      + "\"closeTime\":\"" + IsoTime(p.closeTime) + "\","
      + "\"profit\":" + FmtMoney(p.profit) + ","
      + "\"commission\":" + FmtMoney(p.commission) + ","
      + "\"swap\":" + FmtMoney(p.swap)
      + "}";
}

//+------------------------------------------------------------------+
//| Cursor persistence (per login, survives EA reload)               |
//+------------------------------------------------------------------+
string GVName(string suffix) { return "TB5_" + IntegerToString(g_login) + "_" + suffix; }

void SaveCursor()
{
   GlobalVariableSet(GVName("curT"), (double)g_cursorTime);
   GlobalVariableSet(GVName("curP"), (double)g_cursorPos);
}

void ResetHistoryState()
{
   g_cursorTime  = 0;
   g_cursorPos   = 0;
   g_historyDone = false;
   g_nextScan    = 0;
}

void LoadCursorForLogin()
{
   g_login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(RestartHistory)
   {
      ResetHistoryState();
      Print("TradeBuddy: RestartHistory=true - resending full history for login ", g_login);
      return;
   }
   if(GlobalVariableCheck(GVName("curT"))) g_cursorTime = (datetime)GlobalVariableGet(GVName("curT"));
   if(GlobalVariableCheck(GVName("curP"))) g_cursorPos  = (long)GlobalVariableGet(GVName("curP"));
   if(g_cursorTime > 0) g_historyDone = false;
}

//+------------------------------------------------------------------+
//| Discover candidate position ids: distinct ids that have an OUT   |
//| deal after (cursor - GraceDays). Deal scan order is time-sorted, |
//| so candidates arrive roughly oldest-first.                       |
//+------------------------------------------------------------------+
int DiscoverCandidates(long &ids[])
{
   datetime from = g_cursorTime - (datetime)(GraceDays * 86400);
   if(from < 0) from = 0;
   if(!HistorySelect(from, TimeCurrent() + 86400)) return 0;

   long seen[];
   int n = 0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
   {
      ulong dticket = HistoryDealGetTicket(i);
      if(dticket == 0) continue;
      long entry = HistoryDealGetInteger(dticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      long pid = HistoryDealGetInteger(dticket, DEAL_POSITION_ID);
      if(pid <= 0) continue;
      bool dup = false;
      for(int k = 0; k < n; k++) if(seen[k] == pid) { dup = true; break; }
      if(dup) continue;
      ArrayResize(seen, n + 1, 4096);
      seen[n] = pid;
      n++;
   }
   ArrayResize(ids, n);
   for(int k = 0; k < n; k++) ids[k] = seen[k];
   return n;
}

//+------------------------------------------------------------------+
//| Collect + push one history batch; true when a batch was accepted.|
//+------------------------------------------------------------------+
bool PushHistoryBatch()
{
   if(g_historyDone && TimeCurrent() < g_nextScan) return false;

   long ids[];
   int nIds = DiscoverCandidates(ids);
   if(nIds == 0)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
      return false;
   }

   // Aggregate candidates until we have a batch of eligible (newly closed)
   // positions or candidates run out.
   string tradesJson = "";
   int built = 0;
   datetime newTime = g_cursorTime;
   long newPos = g_cursorPos;

   for(int i = 0; i < nIds && built < HistoryBatch; i++)
   {
      if(!HistorySelectByPosition(ids[i])) continue;
      ClosedPos p;
      if(!AggregateSelectedPosition(ids[i], p)) continue;
      if(p.closeTime == 0) continue;
      // strictly after cursor (tiebreak by position id)
      if(p.closeTime < g_cursorTime ||
         (p.closeTime == g_cursorTime && p.posId <= g_cursorPos)) continue;

      if(built > 0) tradesJson = tradesJson + ",";
      tradesJson = tradesJson + ClosedTradeJson(p);
      if(p.closeTime > newTime || (p.closeTime == newTime && p.posId > newPos))
      {
         newTime = p.closeTime;
         newPos  = p.posId;
      }
      built++;
   }

   if(built == 0)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
      return false;
   }

   string response = "";
   int    status   = 0;
   if(!HttpPostJson(BuildPayload(tradesJson), response, status) || status != 200)
   {
      Print("TradeBuddy: history batch push failed (HTTP ", status, "): ",
            StringSubstr(response, 0, 200));
      return false;
   }

   g_cursorTime = newTime;
   g_cursorPos  = newPos;
   SaveCursor();
   if(built < HistoryBatch)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Account snapshot payload with optional trades batch              |
//+------------------------------------------------------------------+
string BuildPayload(string tradesJson)
{
   if(StringLen(tradesJson) == 0) tradesJson = "[]";

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin  = AccountInfoDouble(ACCOUNT_MARGIN);
   double mlevel  = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);

   return "{"
      + "\"login\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\","
      + "\"platform\":\"MT5\","
      + "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\","
      + "\"accountInfo\":{"
      +   "\"balance\":" + FmtMoney(balance) + ","
      +   "\"equity\":" + FmtMoney(equity) + ","
      +   "\"margin\":" + FmtMoney(margin) + ","
      +   "\"freeMargin\":" + FmtMoney(AccountInfoDouble(ACCOUNT_MARGIN_FREE)) + ","
      +   "\"marginLevel\":" + (margin > 0.0 ? FmtMoney(mlevel) : "null") + ","
      +   "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ","
      +   "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\""
      + "},"
      + "\"positions\":" + PositionsJson() + ","
      + "\"trades\":" + tradesJson + ","
      + "\"ts\":\"" + IsoTime(TimeCurrent()) + "\""
      + "}";
}

void UpdateComment(string state)
{
   string hist = g_historyDone ? "history: up to date"
                               : "history: backfilling...";
   Comment("TradeBuddy agent\n",
           "login: ", g_login, "  (", AccountInfoString(ACCOUNT_SERVER), ")\n",
           "state: ", state, "\n",
           hist, "\n",
           g_lastError == "" ? "" : ("error: " + g_lastError + "\n"));
}

void PushCycle()
{
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login <= 0) { UpdateComment("waiting for account login..."); return; }
   if(login != g_login)
   {
      g_login = login;
      ResetHistoryState();
      LoadCursorForLogin();
      Print("TradeBuddy: pushing login ", g_login, " (", AccountInfoString(ACCOUNT_SERVER), ")");
   }

   bool historyPushed = false;
   int  guard = 0;
   while(PushHistoryBatch() && guard < 3) { historyPushed = true; guard++; }
   if(guard >= 3 && !g_historyDone)
      Print("TradeBuddy: more history batches pending - continuing next cycle");

   string response = "";
   int    status   = 0;
   if(HttpPostJson(BuildPayload(""), response, status) && status == 200)
   {
      if(g_failStreak > 0) Print("TradeBuddy: connection recovered");
      g_failStreak = 0;
      g_lastPushOk = TimeCurrent();
      g_lastError  = "";
      UpdateComment(historyPushed ? "pushed (history backfill in progress)" : "pushed");
      if(VerboseLogs)
         Print("TradeBuddy: pushed snapshot, HTTP 200: ", StringSubstr(response, 0, 120));
   }
   else
   {
      g_failStreak++;
      g_lastError = (status == 0) ? "WebRequest failed" : ("HTTP " + IntegerToString(status) + " " + StringSubstr(response, 0, 120));
      UpdateComment("push FAILED (" + IntegerToString(g_failStreak) + " in a row)");
      Print("TradeBuddy: snapshot push failed (", g_lastError, ")");
   }
}

//+------------------------------------------------------------------+
//| Standard callbacks                                               |
//+------------------------------------------------------------------+
int OnInit()
{
   string url = TBTrim(IngestURL);
   if(StringLen(url) == 0)
   {
      Alert("TradeBuddy agent: IngestURL input is required");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(StringFind(url, "http") != 0)
   {
      Alert("TradeBuddy agent: IngestURL must start with http:// or https://");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_firstTick = true;
   EventSetTimer(2);
   Print("TradeBuddy agent initialized for ", url,
         " (token ", StringLen(IngestToken) > 0 ? "set" : "not set", ")");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   if(g_firstTick)
   {
      g_login = 0;                       // force cursor load on first cycle
      g_firstTick = false;
      PushCycle();
      EventSetTimer((int)MathMax(5, PollSeconds));
      return;
   }
   PushCycle();
}
//+------------------------------------------------------------------+
