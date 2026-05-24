#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:3000}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:8080}"
EMAIL="${ADMIN_EMAIL:-admin@example.com}"
PASSWORD="${ADMIN_PASSWORD:-Admin@123}"

echo "== Docker containers =="
if docker info >/dev/null 2>&1; then
  docker compose ps
else
  echo "Docker daemon is not available; skipping container list."
fi

echo
echo "== Backend health =="
curl -fsS "$BASE_URL/api/health"
echo

echo
echo "== Login POST =="
LOGIN_RESPONSE="$(curl -fsS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
echo "$LOGIN_RESPONSE" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const json=JSON.parse(data); if(!json.token) throw new Error('Missing login token'); console.log('Login OK for '+json.user.email); console.log(json.token);})" > /tmp/casting-login-check.txt
TOKEN="$(tail -1 /tmp/casting-login-check.txt)"
head -1 /tmp/casting-login-check.txt

echo
echo "== Authenticated /me =="
curl -fsS "$BASE_URL/api/auth/me" -H "Authorization: Bearer $TOKEN"
echo

echo
echo "== Seeded wax rows =="
WAX_COUNT="$(curl -fsS "$BASE_URL/api/wax-entries" -H "Authorization: Bearer $TOKEN" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>console.log(JSON.parse(data).length))")"
echo "Wax rows: $WAX_COUNT"
test "$WAX_COUNT" -ge 10

echo
echo "== Invoicing summary =="
curl -fsS "$BASE_URL/api/invoicing/summary" -H "Authorization: Bearer $TOKEN"
echo

echo
echo "== Frontend =="
curl -fsS "$FRONTEND_URL/" | grep -q "Production Management System"
echo "Frontend OK at $FRONTEND_URL"

echo
echo "== Recent backend logs =="
if docker info >/dev/null 2>&1; then
  docker compose logs --tail=80 backend
else
  echo "Docker daemon is not available; skipping container logs."
fi

echo
echo "DEPLOYMENT TEST PASSED"
