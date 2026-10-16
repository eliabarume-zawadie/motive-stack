#!/usr/bin/env bash
# WRITE script (separate from the read-only meta-probe.sh). Creates ONE draft
# Instant Form and ONE test lead on a Page. No ads, no spend. Never prints tokens.
#
# Usage:
#   bash scripts/meta-leadform-test.sh create-form <page_id> <token-line>
#   bash scripts/meta-leadform-test.sh test-lead   <form_id> <page_id> <token-line>
#   bash scripts/meta-leadform-test.sh read-leads  <form_id> <page_id> <token-line>
#
# Safety: create-form refuses to run if a form with the same name already exists
# (so a timed-out request is never blindly repeated). No automatic retries.
set -euo pipefail

GRAPH_VERSION="${GRAPH_VERSION:-v25.0}"
TOKEN_FILE="${TOKEN_FILE:-secret-key}"
FORM_NAME="${FORM_NAME:-MS Test Form}"
G="https://graph.facebook.com/${GRAPH_VERSION}"

cmd="${1:-}"
case "$cmd" in
  create-form) page_id="${2:-}"; line="${3:-}"; form_id="" ;;
  test-lead|read-leads) form_id="${2:-}"; page_id="${3:-}"; line="${4:-}" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
[[ "$page_id" =~ ^[0-9]+$ ]] || { echo "page_id must be numeric"; exit 1; }
[[ "$line" =~ ^[0-9]+$ ]] || { echo "token-line must be numeric"; exit 1; }
if [ "$cmd" != "create-form" ]; then [[ "$form_id" =~ ^[0-9]+$ ]] || { echo "form_id must be numeric"; exit 1; }; fi

TOKEN=$(sed -n "${line}p" "$TOKEN_FILE" | tr -d '\r\n ')
[ -n "$TOKEN" ] || { echo "No token on line $line"; exit 1; }

redact() {
  sed -E 's/"access_token":"[^"]*"/"access_token":"<redacted>"/g; s/"fbtrace_id":"[^"]*"/"fbtrace_id":"<x>"/g; s/"(before|after)":"[^"]*"/"\1":"<c>"/g'
}

PAGE_TOKEN=$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" \
  "$G/$page_id?fields=access_token" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[ -n "$PAGE_TOKEN" ] || { echo "Could not get a Page token (need a role on the Page and pages_show_list)."; exit 1; }

case "$cmd" in
  create-form)
    echo "== existing forms named '$FORM_NAME'?"
    existing=$(curl -s --max-time 30 -H "Authorization: Bearer $PAGE_TOKEN" \
      "$G/$page_id/leadgen_forms?fields=id,name&limit=100")
    echo "$existing" | redact; echo
    if echo "$existing" | grep -qi "\"name\":\"$FORM_NAME\""; then
      echo "A form with this name already exists. Not creating another."; exit 0
    fi
    echo "== create form"
    resp=$(curl -s --max-time 30 -w '\nHTTP %{http_code}' -X POST -H "Authorization: Bearer $PAGE_TOKEN" \
      --data-urlencode "name=$FORM_NAME" \
      --data-urlencode 'questions=[{"type":"FULL_NAME","key":"q1"},{"type":"EMAIL","key":"q2"}]' \
      "$G/$page_id/leadgen_forms")
    echo "$resp" | redact; echo
    ;;
  test-lead)
    echo "== create test lead on form $form_id"
    curl -s --max-time 30 -w '\nHTTP %{http_code}' -X POST -H "Authorization: Bearer $PAGE_TOKEN" \
      "$G/$form_id/test_leads" | redact; echo
    ;;
  read-leads)
    echo "== form $form_id"
    curl -s --max-time 30 -H "Authorization: Bearer $PAGE_TOKEN" "$G/$form_id?fields=id,name,status,leads_count" | redact; echo
    echo "== leads"
    curl -s --max-time 30 -H "Authorization: Bearer $PAGE_TOKEN" "$G/$form_id/leads?fields=id,created_time,field_data&limit=5" | redact; echo
    ;;
esac
