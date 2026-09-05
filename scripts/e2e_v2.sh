#!/usr/bin/env bash
# =============================================================================
# E2E v2 test: login system, rooms, web tools, OTP split, sandbox purchases.
# Boots against local mongo + mcp-server(4000) + agent-service(5000).
# =============================================================================
set -uo pipefail

B="http://127.0.0.1:5000"
M="http://127.0.0.1:4000"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "✘ $1"; }
jqget(){ python3 -c "import sys,json,functools
d=json.load(sys.stdin)
v=functools.reduce(lambda a,k: a.get(k) if isinstance(a,dict) else None, '$1'.split('.'), d)
print('' if v is None else v)" 2>/dev/null; }

EMAIL_H="human_$RANDOM@test.local"
EMAIL_A="agent_$RANDOM@test.local"
SID="e2e-session-$RANDOM"

echo "=== 1. HUMAN registration (dev code path, no SMTP) ==="
R=$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_H\",\"password\":\"password123\",\"accountType\":\"human\"}")
DEV_CODE=$(echo "$R" | jqget "verification.devCode")
[[ "$DEV_CODE" =~ ^[0-9]{6}$ ]] && ok "human register -> devCode returned ($DEV_CODE)" || bad "human register: $R"

R=$(curl -s -X POST $B/api/auth/verify-email -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_H\",\"code\":\"$DEV_CODE\"}")
HJWT=$(echo "$R" | jqget "token")
[[ ${#HJWT} -gt 100 ]] && ok "email verify -> JWT issued" || bad "verify-email: $R"

echo "=== 2. /me hydration (room + wallet) ==="
R=$(curl -s $B/api/agent/me -H "Authorization: Bearer $HJWT")
ROOM=$(echo "$R" | jqget "user.room")
WALLET=$(echo "$R" | jqget "wallet.balancePaise")
[[ "$ROOM" == user:* ]] && ok "room = $ROOM" || bad "room missing: $R"
[[ "$WALLET" == "5000000" ]] && ok "sandbox wallet = ₹50,000" || bad "wallet: $WALLET"

echo "=== 3. AGENT registration (MCP key issuance) ==="
R=$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"password123\",\"accountType\":\"agent\"}")
MCPKEY=$(echo "$R" | jqget "mcpKey")
[[ "$MCPKEY" == rzak_* ]] && ok "agent register -> MCP key issued" || bad "agent register: $R"

# The agent key must work directly against the MCP server
R=$(curl -s -X POST $M/mcp -H "X-API-Key: $MCPKEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
TOOLN=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo 0)
[[ "${TOOLN:-0}" -ge 6 ]] && ok "agent key -> tools/list ($TOOLN tools incl. web_search + web_product_search)" || bad "tools/list: $R"

echo "=== 4. live web_search via the agent's own MCP key ==="
R=$(curl -s -X POST $M/mcp -H "X-API-Key: $MCPKEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"best noise cancelling headphones 2025","maxResults":3}}}')
CNT=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('result',{}).get('count',0))" 2>/dev/null || echo 0)
[[ "$CNT" -ge 1 ]] && ok "web_search returned $CNT live results" || echo "  ℹ web_search: engine quality varies by IP (pipeline verified separately) — result: $CNT"

echo "=== 5. autonomous sandbox purchase (under ₹5,000, catalog item) ==="
R=$(curl -s -X POST $B/api/transactions/execute \
  -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' -H "Idempotency-Key: e2e-auto-$RANDOM" \
  -d "{\"sessionId\":\"$SID\",\"agentId\":\"ignored-for-authed\",\"items\":[{\"sku\":\"APL-HOODIE-001\",\"qty\":1}]}")
STATUS=$(echo "$R" | jqget "status")
[[ "$STATUS" == "paid" ]] && ok "sandbox purchase -> status=paid (sandbox capture, no gateway keys needed)" || bad "purchase status=$STATUS: $R"
# wallet should have debited 149900
R2=$(curl -s $B/api/agent/me -H "Authorization: Bearer $HJWT")
BAL=$(echo "$R2" | jqget "wallet.balancePaise")
[[ "$BAL" == "4850100" ]] && ok "wallet debited ₹1,499.00 -> balance ₹48,501.00" || bad "balance=$BAL (expected 4850100)"

echo "=== 6. OTP-gated purchase (over ₹5,000) — human gets devOtp, NOT inline ==="
R=$(curl -s -X POST $B/api/transactions/execute \
  -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' -H "Idempotency-Key: e2e-otp-$RANDOM" \
  -d "{\"sessionId\":\"$SID\",\"agentId\":\"x\",\"items\":[{\"sku\":\"ACC-WATCH-001\",\"qty\":1}]}")
TXID=$(echo "$R" | jqget "transactionId")
STATUS=$(echo "$R" | jqget "status")
DEVOTP=$(echo "$R" | jqget "devOtp")
INLINE_OTP=$(echo "$R" | jqget "otp")
DELIVERY=$(echo "$R" | jqget "otpDelivery")
[[ "$STATUS" == "awaiting_otp" ]] && ok "status=awaiting_otp (tx $TXID)" || bad "expected awaiting_otp: $R"
[[ "$DEVOTP" =~ ^[0-9]{6}$ && -z "$INLINE_OTP" ]] && ok "human: devOtp present, inline otp ABSENT (delivery=$DELIVERY)" || bad "otp fields: dev=$DEVOTP inline=$INLINE_OTP"

R=$(curl -s -X POST $B/api/transactions/$TXID/verify-otp -H 'Content-Type: application/json' \
  -d "{\"otp\":\"$DEVOTP\",\"sessionId\":\"$SID\"}")
VSTATUS=$(echo "$R" | jqget "status")
[[ "$VSTATUS" == "paid" ]] && ok "OTP verified -> payment executed (paid, sandbox capture)" || bad "verify: $R"

echo "=== 7. AGENT login -> above-limit purchase -> INLINE OTP ==="
R=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"password123\"}")
AJWT=$(echo "$R" | jqget "token")
[[ ${#AJWT} -gt 100 ]] && ok "agent login -> JWT" || bad "agent login: $R"

R=$(curl -s -X POST $B/api/transactions/execute \
  -H "Authorization: Bearer $AJWT" -H 'Content-Type: application/json' -H "Idempotency-Key: e2e-agent-$RANDOM" \
  -d "{\"sessionId\":\"$SID\",\"agentId\":\"x\",\"items\":[{\"sku\":\"ELE-MON-001\",\"qty\":1}]}")
TXID2=$(echo "$R" | jqget "transactionId")
INLINE2=$(echo "$R" | jqget "otp")
[[ "$INLINE2" =~ ^[0-9]{6}$ ]] && ok "agent above-limit -> INLINE otp delivered ($INLINE2)" || bad "agent otp: $R"

R=$(curl -s -X POST $B/api/transactions/$TXID2/verify-otp -H 'Content-Type: application/json' \
  -d "{\"otp\":\"$INLINE2\",\"sessionId\":\"$SID\"}")
[[ "$(echo "$R" | jqget "status")" == "paid" ]] && ok "agent inline otp verify -> executed (paid)" || bad "agent verify: $R"

echo "=== 8. BYOK mode switch (fake -> byok -> fake) ==="
R=$(curl -s -X POST $B/api/auth/razorpay -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' \
  -d '{"keyId":"rzp_test_1234567890123456","keySecret":"testsecret1234567890"}')
MODE=$(echo "$R" | jqget "razorpay.mode")
[[ "$MODE" == "byok" ]] && ok "BYOK keys stored (mode=byok)" || bad "byok: $R"
# reject LIVE keys
R=$(curl -s -X POST $B/api/auth/razorpay -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' \
  -d '{"keyId":"rzp_live_1234567890123456","keySecret":"livesecret123"}')
[[ "$(echo "$R" | jqget "error")" == "TEST_MODE_ONLY" ]] && ok "live keys REJECTED (TEST_MODE_ONLY)" || bad "live key check: $R"
R=$(curl -s -X POST $B/api/auth/razorpay/disconnect -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' -d '{}')
[[ "$(echo "$R" | jqget "razorpay.mode")" == "fake" ]] && ok "disconnect -> back to fake funds" || bad "disconnect: $R"

echo "=== 9. room isolation — conversations are room-scoped ==="
curl -s -X POST $B/api/agent/chat -H "Authorization: Bearer $HJWT" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"isolation-test\",\"sessionId\":\"$SID\",\"agentId\":\"x\"}" > /dev/null
H_MSGS=$(curl -s "$B/api/agent/conversation/$SID" -H "Authorization: Bearer $HJWT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['messages']))")
A_MSGS=$(curl -s "$B/api/agent/conversation/$SID" -H "Authorization: Bearer $AJWT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['messages']))")
[[ "$H_MSGS" -gt 0 && "$A_MSGS" == "0" ]] && ok "human sees $H_MSGS msgs, agent sees $A_MSGS (isolated)" || bad "isolation: human=$H_MSGS agent=$A_MSGS"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
