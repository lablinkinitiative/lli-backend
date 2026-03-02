#!/usr/bin/env bash
# LabLink Internship Pipeline — Entry Point
# ==========================================
# Runs the full agent-native pipeline:
#   1. Orchestrator deploys 9 sector agents in parallel
#   2. Agents web-search and extract real program data
#   3. Results normalized and upserted to CDP database
#   4. Summary posted to Slack
#
# Usage:
#   ./run-pipeline.sh [--sectors all|01,03] [--dry-run] [--skip-upsert] [--skip-slack]

set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="/home/agent/data/lablink.db"
CREDS_FILE="/home/agent/bootstrap/credentials/slack-credentials.env"
SLACK_CHANNEL="C0AF9DAR5L5"
LOG_FILE="$PIPELINE_DIR/output/pipeline-$(date +%Y%m%d-%H%M%S).log"

# Parse args
SECTORS="all"
DRY_RUN=""
SKIP_UPSERT=""
SKIP_SLACK=""

for arg in "$@"; do
    case $arg in
        --sectors=*) SECTORS="${arg#*=}" ;;
        --sectors) shift; SECTORS="$1" ;;
        --dry-run) DRY_RUN="--dry-run" ;;
        --skip-upsert) SKIP_UPSERT="1" ;;
        --skip-slack) SKIP_SLACK="1" ;;
    esac
done

echo "=================================================="
echo "LabLink Internship Pipeline — $(date)"
echo "Sectors: $SECTORS"
echo "=================================================="

mkdir -p "$PIPELINE_DIR/output"

# Step 1: Run orchestrator (deploys agents in parallel)
echo ""
echo "STEP 1: Deploying sector agents..."
ORCHESTRATOR_ARGS="--sectors $SECTORS --max-workers 5"
if [ -n "$DRY_RUN" ]; then
    ORCHESTRATOR_ARGS="$ORCHESTRATOR_ARGS --dry-run"
fi

SUMMARY=$(python3 "$PIPELINE_DIR/orchestrator.py" $ORCHESTRATOR_ARGS 2>&1 | tee -a "$LOG_FILE" | tail -1)
echo "Orchestrator summary: $SUMMARY"

if [ -n "$DRY_RUN" ]; then
    echo "DRY RUN complete."
    exit 0
fi

# Step 2: Upsert to database
if [ -z "$SKIP_UPSERT" ]; then
    echo ""
    echo "STEP 2: Upserting to CDP database..."

    if [ -f "$PIPELINE_DIR/output/all-programs.json" ]; then
        UPSERT_STATS=$(python3 "$PIPELINE_DIR/upsert.py" \
            --input "$PIPELINE_DIR/output/all-programs.json" \
            --db "$DB_PATH" 2>&1 | tee -a "$LOG_FILE" | tail -1)
        echo "Upsert stats: $UPSERT_STATS"
    else
        echo "No all-programs.json found — skipping upsert"
        UPSERT_STATS='{"error": "no output file"}'
    fi
else
    echo "STEP 2: Skipped (--skip-upsert)"
    UPSERT_STATS='{}'
fi

# Step 3: Sync programs to frontend sites (CDP app + intern site use API now)
if [ -z "$SKIP_UPSERT" ]; then
    echo ""
    echo "STEP 3: Syncing programs to CDP app..."
    # Restart API to bust sector map cache, then rebuild CDP app
    sudo systemctl restart lablink-api.service 2>/dev/null || true
    sleep 3
    if [ -f "$HOME/scripts/sync-cdp-programs.sh" ]; then
        bash "$HOME/scripts/sync-cdp-programs.sh" 2>&1 | tee -a "$LOG_FILE" || echo "CDP sync failed (non-fatal)"
    fi
else
    echo "STEP 3: Skipped (upsert skipped)"
fi

# Step 4: Post to Slack
if [ -z "$SKIP_SLACK" ]; then
    echo ""
    echo "STEP 4: Posting results to Slack..."

    python3 "$PIPELINE_DIR/notify.py" \
        --summary "$SUMMARY" \
        --upsert-stats "$UPSERT_STATS" \
        --log-file "$LOG_FILE" 2>&1 | tee -a "$LOG_FILE"
else
    echo "STEP 4: Skipped (--skip-slack)"
fi

echo ""
echo "Pipeline complete. Log: $LOG_FILE"
