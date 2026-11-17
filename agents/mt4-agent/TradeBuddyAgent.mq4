//+------------------------------------------------------------------+
//|  TradeBuddyAgent.mq4                                             |
//|  Push agent for TradeBuddy (self-hosted MT4/MT5 account monitor) |
//|                                                                  |
//|  Runs INSIDE your MT4 terminal (Windows, or Wine) and pushes:    |
//|    - account balance/equity/margin snapshots                     |
//|    - currently open positions                                    |
//|    - closed trade history (full backfill once, then incremental) |
//|  to the dashboard's /api/ingest endpoint.                        |
//|                                                                  |
//|  SETUP (one time):                                               |
//|   1. Copy this file to <MT4 Data Folder>/MQL4/Experts            |
//|      (MT4 menu: File -> Open Data Folder), compile in MetaEditor |
//|      (F7).                                                       |
//|   2. MT4: Tools -> Options -> Expert Advisors -> tick            |
//|      "Allow WebRequest for listed URL" and add the dashboard     |
//|      base URL (e.g. https://tradebuddy.example.com).             |
//|   3. Add the account in the TradeBuddy dashboard (same login +   |
//|      broker server, investor password).                          |
//|   4. Attach this EA to any chart and fill IngestURL/IngestToken  |
//|      (values are shown in the dashboard's "Setup guide").        |
//|   5. Terminal -> Account History tab -> right click ->           |
//|      "All History" so the EA can read your full trade history.   |
//|                                                                  |
//|  Read-only: the EA never trades. AutoTrading is NOT required.    |
//|  Data is deduplicated server-side by (login, positionId).        |
//+------------------------------------------------------------------+
#property copyright "TradeBuddy"
#property link      "https://github.com/iain504/tradebuddy"
#property version   "1.00"
#property strict
#property description "Pushes your MT4 account snapshots and trade history to a TradeBuddy dashboard."

input string IngestURL      = "http://localhost:3000/api/ingest"; // TradeBuddy ingest endpoint
input string IngestToken    = "";                                  // X-Ingest-Token value
input int    PollSeconds    = 30;     // Seconds between pushes
input int    HistoryBatch   = 200;    // Closed trades sent per request
input int    TimeoutMs      = 10000;  // WebRequest timeout (ms)
input int    RescanMinutes  = 5;      // Re-check for newly closed trades every N minutes
input bool   RestartHistory = false;  // Re-send full history once (ignores saved progress)
input bool   VerboseLogs    = false;  // Log every successful push

// --- state ------------------------------------------------------- //
datetime g_cursorTime    = 0;      // history pagination cursor (close time)
long     g_cursorTicket  = 0;      // history pagination cursor (ticket tiebreak)
long     g_login         = 0;      // account the cursor belongs to
bool     g_historyDone   = false;  // no candidates left after cursor
datetime g_nextScan      = 0;      // when to re-check for newly closed trades
int      g_failStreak    = 0;
string   g_lastError     = "";
datetime g_lastPushOk    = 0;
bool     g_firstTick     = true;

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

// ASCII-safe JSON string escape (drops non-ASCII to keep WebRequest bodies simple)
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
      else                    outp = outp + CharToString((uchar)c);
   }
   return outp;
}

// ISO-8601 UTC-ish timestamp (terminal server time, Z-suffixed like MT5 data)
string IsoTime(datetime t)
{
   if(t <= 0) return "1970-01-01T00:00:00Z";
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       TimeYear(t), TimeMonth(t), TimeDay(t),
                       TimeHour(t), TimeMinute(t), TimeSeconds(t));
}

string FmtMoney(double v) { return DoubleToString(v, 2); }

string FmtPrice(string symbol, double v)
{
   int digits = 5;
   if(StringLen(symbol) > 0)
   {
      int d = (int)MarketInfo(symbol, MODE_DIGITS);
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

   ArrayResize(data, 0);
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
            "). If this keeps happening: MT4 -> Tools -> Options -> Expert Advisors -> ",
            "tick 'Allow WebRequest for listed URL' and add the dashboard base URL.");
      return false;
   }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

//+------------------------------------------------------------------+
//| Open positions (market orders only, pendings are skipped)        |
//+------------------------------------------------------------------+
string PositionsJson()
{
   string arr = "";
   int count = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      int t = OrderType();
      if(t != OP_BUY && t != OP_SELL) continue;
      if(count > 0) arr = arr + ",";
      arr = arr + "{"
         + "\"positionId\":\"" + IntegerToString(OrderTicket()) + "\","
         + "\"symbol\":\"" + JsonEscape(OrderSymbol()) + "\","
         + "\"side\":\"" + (t == OP_BUY ? "BUY" : "SELL") + "\","
         + "\"volume\":" + DoubleToString(OrderLots(), 2) + ","
         + "\"openPrice\":" + FmtPrice(OrderSymbol(), OrderOpenPrice()) + ","
         + "\"currentPrice\":" + FmtPrice(OrderSymbol(), OrderClosePrice()) + ","
         + "\"openTime\":\"" + IsoTime(OrderOpenTime()) + "\","
         + "\"profit\":" + FmtMoney(OrderProfit()) + ","
         + "\"swap\":" + FmtMoney(OrderSwap())
         + "}";
      count++;
   }
   return "[" + arr + "]";
}

//+------------------------------------------------------------------+
//| Closed trade JSON (OrderSelect'ed history order)                 |
//+------------------------------------------------------------------+
string ClosedTradeJson()
{
   string symbol = OrderSymbol();
   int    t      = OrderType();
   return "{"
      + "\"positionId\":\"" + IntegerToString(OrderTicket()) + "\","
      + "\"symbol\":\"" + JsonEscape(symbol) + "\","
      + "\"side\":\"" + (t == OP_BUY ? "BUY" : "SELL") + "\","
      + "\"volume\":" + DoubleToString(OrderLots(), 2) + ","
      + "\"openPrice\":" + FmtPrice(symbol, OrderOpenPrice()) + ","
      + "\"closePrice\":" + FmtPrice(symbol, OrderClosePrice()) + ","
      + "\"openTime\":\"" + IsoTime(OrderOpenTime()) + "\","
      + "\"closeTime\":\"" + IsoTime(OrderCloseTime()) + "\","
      + "\"profit\":" + FmtMoney(OrderProfit()) + ","
      + "\"commission\":" + FmtMoney(OrderCommission()) + ","
      + "\"swap\":" + FmtMoney(OrderSwap())
      + "}";
}

//+------------------------------------------------------------------+
//| Account snapshot payload with optional trades batch              |
//+------------------------------------------------------------------+
string BuildPayload(string tradesJson)
{
   if(StringLen(tradesJson) == 0) tradesJson = "[]";

   double balance = AccountBalance();
   double equity  = AccountEquity();
   double margin  = AccountMargin();
   double mlevel  = (margin > 0.0) ? equity / margin * 100.0 : 0.0;

   return "{"
      + "\"login\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\","
      + "\"platform\":\"MT4\","
      + "\"server\":\"" + JsonEscape(AccountServer()) + "\","
      + "\"accountInfo\":{"
      +   "\"balance\":" + FmtMoney(balance) + ","
      +   "\"equity\":" + FmtMoney(equity) + ","
      +   "\"margin\":" + FmtMoney(margin) + ","
      +   "\"freeMargin\":" + FmtMoney(AccountFreeMargin()) + ","
      +   "\"marginLevel\":" + (margin > 0.0 ? FmtMoney(mlevel) : "null") + ","
      +   "\"leverage\":" + IntegerToString(AccountLeverage()) + ","
      +   "\"currency\":\"" + JsonEscape(AccountCurrency()) + "\""
      + "},"
      + "\"positions\":" + PositionsJson() + ","
      + "\"trades\":" + tradesJson + ","
      + "\"ts\":\"" + IsoTime(TimeCurrent()) + "\""
      + "}";
}

//+------------------------------------------------------------------+
//| Cursor persistence (per login, survives EA reload)               |
//+------------------------------------------------------------------+
string GVName(string suffix) { return "TB_" + IntegerToString(g_login) + "_" + suffix; }

void SaveCursor()
{
   GlobalVariableSet(GVName("curT"), (double)g_cursorTime);
   GlobalVariableSet(GVName("curK"), (double)g_cursorTicket);
}

void ResetHistoryState()
{
   g_cursorTime   = 0;
   g_cursorTicket = 0;
   g_historyDone  = false;
   g_nextScan     = 0;
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
   if(GlobalVariableCheck(GVName("curT"))) g_cursorTime   = (datetime)GlobalVariableGet(GVName("curT"));
   if(GlobalVariableCheck(GVName("curK"))) g_cursorTicket = (long)GlobalVariableGet(GVName("curK"));
   if(g_cursorTime > 0) g_historyDone = false;
}

//+------------------------------------------------------------------+
//| Collect + push one history batch; returns true when a batch was  |
//| accepted by the server (cursor advanced).                        |
//+------------------------------------------------------------------+
bool PushHistoryBatch()
{
   if(g_historyDone && TimeCurrent() < g_nextScan) return false;

   int total = OrdersHistoryTotal();
   if(total == 0)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
      return false;
   }

   // 1. Collect closed market trades after the cursor.
   long     tickets[];
   datetime closes[];
   int n = 0;
   for(int i = 0; i < total; i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      int t = OrderType();
      if(t != OP_BUY && t != OP_SELL) continue;      // skip balance/credit/pending
      datetime ct = OrderCloseTime();
      if(ct <= 0) continue;
      long tk = (long)OrderTicket();
      if(ct < g_cursorTime || (ct == g_cursorTime && tk <= g_cursorTicket)) continue;
      ArrayResize(tickets, n + 1, 4096);
      ArrayResize(closes,  n + 1, 4096);
      tickets[n] = tk;
      closes[n]  = ct;
      n++;
   }

   if(n == 0)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
      return false;
   }

   // 2. Sort ascending by (closeTime, ticket) - insertion sort; candidates
   //    shrink every tick so this is only heavy during the first backfill.
   for(int i = 1; i < n; i++)
   {
      long tk     = tickets[i];
      datetime ct = closes[i];
      int j = i - 1;
      while(j >= 0 && (closes[j] > ct || (closes[j] == ct && tickets[j] > tk)))
      {
         tickets[j + 1] = tickets[j];
         closes[j + 1]  = closes[j];
         j--;
      }
      tickets[j + 1] = tk;
      closes[j + 1]  = ct;
   }

   // 3. Build the batch JSON, remembering where the cursor would move.
   int    batch      = MathMin(HistoryBatch, n);
   string tradesJson = "";
   int    built      = 0;
   datetime newTime   = g_cursorTime;
   long     newTicket = g_cursorTicket;
   for(int i = 0; i < batch; i++)
   {
      if(!OrderSelect((int)tickets[i], SELECT_BY_TICKET)) continue;
      if(built > 0) tradesJson = tradesJson + ",";
      tradesJson = tradesJson + ClosedTradeJson();
      newTime   = closes[i];
      newTicket = tickets[i];
      built++;
   }
   if(built == 0) return false;

   // 4. Push. The cursor only advances when the server accepted the batch
   //    (a failed push is retried next tick; the app dedupes re-sends).
   string response = "";
   int    status   = 0;
   if(!HttpPostJson(BuildPayload(tradesJson), response, status) || status != 200)
   {
      Print("TradeBuddy: history batch push failed (HTTP ", status, "): ",
            StringSubstr(response, 0, 200));
      return false;
   }

   g_cursorTime   = newTime;
   g_cursorTicket = newTicket;
   SaveCursor();
   if(n - batch <= 0)
   {
      g_historyDone = true;
      g_nextScan    = TimeCurrent() + RescanMinutes * 60;
   }
   return true;
}

//+------------------------------------------------------------------+
//| One timer cycle                                                  |
//+------------------------------------------------------------------+
void PushCycle()
{
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login <= 0) { UpdateComment("waiting for account login..."); return; }
   if(login != g_login)
   {
      g_login = login;
      ResetHistoryState();
      LoadCursorForLogin();
      Print("TradeBuddy: pushing login ", g_login, " (", AccountServer(), ")");
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

void UpdateComment(string state)
{
   string hist = g_historyDone ? "history: up to date"
                               : "history: backfilling...";
   Comment("TradeBuddy agent\n",
           "login: ", g_login, "  (", AccountServer(), ")\n",
           "state: ", state, "\n",
           hist, "\n",
           g_lastError == "" ? "" : ("error: " + g_lastError + "\n"));
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
   EventSetTimer(2);   // first push quickly; switches to PollSeconds after
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
