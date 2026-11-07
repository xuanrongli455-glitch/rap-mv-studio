#!/usr/bin/env bash
# rap-mv/scripts/deploy-github.sh — 一鍵把專案推上 GitHub 並開啟 Pages。
#
# 用法（token 只放在環境變數，不會寫進 git config 或任何檔案）：
#   GITTOKEN='ghp_xxx' OWNER='帳號' REPO='rap-mv-studio' bash scripts/deploy-github.sh
#
# 做的事：
#   1. 用 REST API 建立 public repo（已存在就跳過）
#   2. 設定 remote（乾淨 URL，不含 token）
#   3. 推 main 分支（token 只用於這一次 push 的認證）
#   4. 開啟 GitHub Pages（main / 根目錄）
#   5. 輪詢 Pages 狀態直到 published，印出網址
set -euo pipefail

: "${GITTOKEN:?需要 GITTOKEN 環境變數}"
OWNER="${OWNER:-}"
REPO="${REPO:-rap-mv-studio}"
BRANCH="${BRANCH:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "$OWNER" ]; then
  OWNER=$(curl -sS -m 20 -H "Authorization: Bearer $GITTOKEN" \
          -H "Accept: application/vnd.github+json" https://api.github.com/user \
          | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$OWNER" ] || { echo "❌ 無法從 token 取得帳號，請明確設 OWNER="; exit 1; }
fi
echo "👤 $OWNER / 📦 $REPO"

api() {
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -m 30 -X "$method" -H "Authorization: Bearer $GITTOKEN" \
      -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
      -d "$data" -w $'\n%{http_code}' "$url"
  else
    curl -sS -m 30 -X "$method" -H "Authorization: Bearer $GITTOKEN" \
      -H "Accept: application/vnd.github+json" -w $'\n%{http_code}' "$url"
  fi
}

# ── 1. 建立 repo ──
echo "① 建立 repo…"
resp=$(api GET "https://api.github.com/repos/$OWNER/$REPO")
code=$(printf '%s' "$resp" | tail -n1)
if [ "$code" = "200" ]; then
  echo "   已存在，直接使用"
else
  resp=$(api POST "https://api.github.com/user/repos" \
    "{\"name\":\"$REPO\",\"description\":\"3D 說唱 MV 工作室 — WebGL 即時渲染 + 錄影導出\",\"private\":false,\"has_issues\":false,\"has_wiki\":false}")
  code=$(printf '%s' "$resp" | tail -n1)
  [ "$code" = "201" ] || { echo "❌ 建立失敗 (HTTP $code)"; printf '%s\n' "$resp" | sed '$d' | head -20; exit 1; }
  echo "   已建立 ✅"
fi

# ── 2. remote（乾淨 URL）──
echo "② 設定 remote…"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
git branch -M "$BRANCH"

# ── 3. 推送 ──
# 這個環境的 git 是 libgit2，不吃 http.extraHeader；憑證走 URL 或 GH_TOKEN。
# 這裡用「帶 token 的一次性 URL」推，推完立刻把 remote 換回乾淨網址，避免 token 留在 .git/config。
echo "③ 推送 $BRANCH…"
GH_TOKEN="$GITTOKEN" GITHUB_TOKEN="$GITTOKEN" \
  git push "https://x-access-token:$GITTOKEN@github.com/$OWNER/$REPO.git" \
  "$BRANCH:$BRANCH" 2>&1 | tail -5
git remote set-url origin "https://github.com/$OWNER/$REPO.git"
git remote -v | head -2

# 清掉可能被寫入的認證暫存
rm -f "$HOME/.git-credentials" 2>/dev/null || true
git config --local --unset-all credential.helper 2>/dev/null || true

# ── 4. 開啟 Pages ──
echo "④ 開啟 GitHub Pages…"
resp=$(api GET "https://api.github.com/repos/$OWNER/$REPO/pages")
code=$(printf '%s' "$resp" | tail -n1)
if [ "$code" = "200" ]; then
  echo "   已開啟過"
else
  resp=$(api POST "https://api.github.com/repos/$OWNER/$REPO/pages" "{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}")
  code=$(printf '%s' "$resp" | tail -n1)
  if [ "$code" = "201" ] || [ "$code" = "409" ]; then
    echo "   已請求建立 ✅"
  else
    echo "   ⚠ Pages 建立回應 HTTP $code（可能需要在網頁上手動開：Settings → Pages）"
    printf '%s\n' "$resp" | sed '$d' | head -10
  fi
fi

# ── 5. 等 Pages 上線 ──
URL="https://$OWNER.github.io/$REPO/"
echo "⑤ 等待 Pages 佈署（最多 5 分鐘）…"
for i in $(seq 1 30); do
  status=$(api GET "https://api.github.com/repos/$OWNER/$REPO/pages/builds/latest" \
    | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  http=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$URL" || echo 000)
  echo "   [${i}/30] build=$status http=$http"
  if [ "$status" = "built" ] || [ "$http" = "200" ]; then
    echo ""
    echo "✅ 完成！iPad / 任何裝置開："
    echo "   $URL"
    echo "   自檢頁：${URL}selftest.html"
    exit 0
  fi
  sleep 10
done
echo "⏳ 還沒上線，請 1 分鐘後自己開：$URL（或用 /pages/builds/latest 看狀態）"
