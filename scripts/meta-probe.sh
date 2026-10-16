#!/usr/bin/env bash
# Read-only Meta Graph API probe. Makes GET requests only.
# Never prints tokens: every response is passed through redact() before output.
#
# Usage: bash scripts/meta-probe.sh <command> [token-line]
#   permissions            granted permissions of the token
#   adaccounts             ad accounts visible to the token
#   pages                  Pages visible to the token (names, IDs, tasks)
#   leadforms <page_id>    lead forms of a Page (uses the Page token internally)
#   subscriptions <page_id>  apps subscribed to the Page's webhooks
#
# token-line: line number in secret-key holding the token.
#             Default: last non-empty line.
# Env: GRAPH_VERSION (default v25.0), TOKEN_FILE (default secret-key)
set -euo pipefail

GRAPH_VERSION="${GRAPH_VERSION:-v25.0}"
TOKEN_FILE="${TOKEN_FILE:-secret-key}"
G="https://graph.facebook.com/${GRAPH_VERSION}"

cmd="${1:-}"
[ -n "$cmd" ] || { sed -n '2,15p' "$0"; exit 1; }

if [ -n "${2:-}" ] && [ "$cmd" != "leadforms" ] && [ "$cmd" != "subscriptions" ]; then
  line="$2"
elif [ -n "${3:-}" ]; then
  line="$3"
else
  line=""
fi

if [ -n "$line" ]; then
  TOKEN=$(sed -n "${line}p" "$TOKEN_FILE" | tr -d '\r\n ')
else
  TOKEN=$(grep -v '^[[:space:]]*$' "$TOKEN_FILE" | tail -1 | tr -d '\r\n ')
fi
[ -n "$TOKEN" ] || { echo "No token found in $TOKEN_FILE"; exit 1; }

redact() {
  sed -E 's/"access_token":"[^"]*"/"access_token":"<redacted>"/g; s/"fbtrace_id":"[^"]*"/"fbtrace_id":"<x>"/g; s/"(before|after)":"[^"]*"/"\1":"<c>"/g'
}

get() { # get <token> <path-and-query>
  curl -s --max-time 30 -G -H "Authorization: Bearer $1" "$G/$2" | redact
  echo
}

case "$cmd" in
  permissions) get "$TOKEN" "me/permissions" ;;
  adaccounts)  get "$TOKEN" "me/adaccounts?fields=id,name,account_status,currency&limit=25" ;;
  pages)       get "$TOKEN" "me/accounts?fields=id,name,tasks&limit=25" ;;
  leadforms|subscriptions)
    page_id="${2:-}"
    [[ "$page_id" =~ ^[0-9]+$ ]] || { echo "page_id must be numeric"; exit 1; }
    PAGE_TOKEN=$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" \
      "$G/$page_id?fields=access_token" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
    if [ -z "$PAGE_TOKEN" ]; then
      echo "No Page token returned (needs pages_show_list and a role on the Page). Falling back to the user token."
      PAGE_TOKEN="$TOKEN"
    fi
    if [ "$cmd" = "leadforms" ]; then
      get "$PAGE_TOKEN" "$page_id/leadgen_forms?fields=id,name,status&limit=25"
    else
      get "$PAGE_TOKEN" "$page_id/subscribed_apps"
    fi
    ;;
  *) echo "Unknown command: $cmd"; exit 1 ;;
esac
