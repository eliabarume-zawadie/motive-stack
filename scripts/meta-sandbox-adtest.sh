#!/usr/bin/env bash
# WRITE script. SANDBOX ad account only. Creates a PAUSED ad set, image, creative, and ad,
# then reads them back. Sandbox ads never deliver and never spend. Never prints tokens.
#
# Usage: bash scripts/meta-sandbox-adtest.sh <step> <token-line>
#   steps: adset | image | creative | ad | readback
# Required env (defaults are the verified IDs for this project):
#   SANDBOX_ACCT=act_2327392417830705  CAMPAIGN_ID=120330000133172415
#   PAGE_ID=1368224686372492           FORM_ID=2117893429115072
# Safety: each create step first looks for an object with the same name and refuses to
# create a duplicate. No automatic retries. Aborts if the account is not the sandbox.
set -euo pipefail

GRAPH_VERSION="${GRAPH_VERSION:-v25.0}"
TOKEN_FILE="${TOKEN_FILE:-secret-key}"
SANDBOX_ACCT="${SANDBOX_ACCT:-act_2327392417830705}"
CAMPAIGN_ID="${CAMPAIGN_ID:-120330000133172415}"
PAGE_ID="${PAGE_ID:-1368224686372492}"
FORM_ID="${FORM_ID:-2117893429115072}"
IMAGE_FILE="${IMAGE_FILE:-docs/MotiveStack AI Marketing Logo.png}"
G="https://graph.facebook.com/${GRAPH_VERSION}"
[ "$SANDBOX_ACCT" = "act_2327392417830705" ] || { echo "Refusing: not the sandbox account"; exit 1; }

step="${1:-}"; line="${2:-}"
[[ "$line" =~ ^[0-9]+$ ]] || { sed -n '2,13p' "$0"; exit 1; }
TOKEN=$(sed -n "${line}p" "$TOKEN_FILE" | tr -d '\r\n ')
[ -n "$TOKEN" ] || { echo "No token on line $line"; exit 1; }

redact() { sed -E 's/"access_token":"[^"]*"/"access_token":"<redacted>"/g; s/"fbtrace_id":"[^"]*"/"fbtrace_id":"<x>"/g; s/"(before|after)":"[^"]*"/"\1":"<c>"/g'; }
get()  { curl -s --max-time 30 -G -H "Authorization: Bearer $TOKEN" "$G/$1"; }
post() { local p="$1"; shift; curl -s --max-time 30 -X POST -H "Authorization: Bearer $TOKEN" "$@" "$G/$p"; }
idof() { grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4; }

exists() { # exists <edge> <name>
  get "$SANDBOX_ACCT/$1?fields=id,name&limit=100" | grep -qF "\"name\":\"$2\""
}

case "$step" in
  adset)
    N="MS-TEST-ADSET"
    if exists adsets "$N"; then echo "Ad set '$N' already exists. Not creating."; exit 0; fi
    post "$SANDBOX_ACCT/adsets" \
      --data-urlencode "name=$N" --data-urlencode "campaign_id=$CAMPAIGN_ID" \
      --data-urlencode "billing_event=IMPRESSIONS" --data-urlencode "optimization_goal=LEAD_GENERATION" \
      --data-urlencode "destination_type=ON_AD" --data-urlencode "bid_strategy=LOWEST_COST_WITHOUT_CAP" \
      --data-urlencode "daily_budget=1000" \
      --data-urlencode "promoted_object={\"page_id\":\"$PAGE_ID\"}" \
      --data-urlencode 'targeting={"geo_locations":{"countries":["US"]}}' \
      --data-urlencode "status=PAUSED" | redact; echo ;;
  image)
    [ -f "$IMAGE_FILE" ] || { echo "Image not found: $IMAGE_FILE"; exit 1; }
    post "$SANDBOX_ACCT/adimages" -F "filename=@$IMAGE_FILE" | redact; echo ;;
  creative)
    HASH="${IMAGE_HASH:-}"; [ -n "$HASH" ] || { echo "Set IMAGE_HASH from the image step"; exit 1; }
    N="MS-TEST-CREATIVE"
    if exists adcreatives "$N"; then echo "Creative '$N' already exists. Not creating."; exit 0; fi
    SPEC=$(printf '{"page_id":"%s","link_data":{"link":"https://fb.me/","message":"MotiveStack test message","description":"Test","image_hash":"%s","call_to_action":{"type":"SIGN_UP","value":{"lead_gen_form_id":"%s"}}}}' "$PAGE_ID" "$HASH" "$FORM_ID")
    post "$SANDBOX_ACCT/adcreatives" --data-urlencode "name=$N" --data-urlencode "object_story_spec=$SPEC" | redact; echo ;;
  ad)
    ADSET="${ADSET_ID:-}"; CREATIVE="${CREATIVE_ID:-}"
    [ -n "$ADSET" ] && [ -n "$CREATIVE" ] || { echo "Set ADSET_ID and CREATIVE_ID"; exit 1; }
    N="MS-TEST-AD"
    if exists ads "$N"; then echo "Ad '$N' already exists. Not creating."; exit 0; fi
    post "$SANDBOX_ACCT/ads" --data-urlencode "name=$N" --data-urlencode "adset_id=$ADSET" \
      --data-urlencode "creative={\"creative_id\":\"$CREATIVE\"}" --data-urlencode "status=PAUSED" | redact; echo ;;
  readback)
    echo "== campaigns"; get "$SANDBOX_ACCT/campaigns?fields=id,name,status,effective_status" | redact; echo
    echo "== adsets"; get "$SANDBOX_ACCT/adsets?fields=id,name,status,effective_status,optimization_goal,daily_budget,destination_type" | redact; echo
    echo "== creatives"; get "$SANDBOX_ACCT/adcreatives?fields=id,name" | redact; echo
    echo "== ads"; get "$SANDBOX_ACCT/ads?fields=id,name,status,effective_status" | redact; echo ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
