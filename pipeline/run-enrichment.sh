#!/usr/bin/env bash
# CDP Program Tag Enrichment Runner
# ===================================
# Splits all 392 programs across 5 parallel workers using Claude subagents.
# Each worker processes its assigned range in batches of 10.
#
# Usage:
#   ./run-enrichment.sh [--workers N] [--unenriched-only] [--dry-run]

set -uo pipefail

PIPELINE_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="/home/agent/data/lablink.db"
LOG_DIR="$PIPELINE_DIR/output"
NUM_WORKERS=5
DRY_RUN=""
UNENRICHED_ONLY=""

for arg in "$@"; do
    case $arg in
        --workers=*) NUM_WORKERS="${arg#*=}" ;;
        --unenriched-only) UNENRICHED_ONLY="--unenriched-only" ;;
        --dry-run) DRY_RUN="--dry-run" ;;
    esac
done

mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
MAIN_LOG="$LOG_DIR/enrichment-$TIMESTAMP.log"

echo "======================================" | tee -a "$MAIN_LOG"
echo "CDP Tag Enrichment — $(date)" | tee -a "$MAIN_LOG"
echo "Workers: $NUM_WORKERS" | tee -a "$MAIN_LOG"
echo "DB: $DB_PATH" | tee -a "$MAIN_LOG"
echo "======================================" | tee -a "$MAIN_LOG"

# Get total count
TOTAL=$(python3 -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
print(conn.execute('SELECT COUNT(*) FROM cdp_programs WHERE is_active=1').fetchone()[0])
")
echo "Total active programs: $TOTAL" | tee -a "$MAIN_LOG"

# Launch workers in parallel
PIDS=()
WORKER_LOGS=()

for i in $(seq 1 $NUM_WORKERS); do
    WORKER_LOG="$LOG_DIR/enrichment-$TIMESTAMP-worker$i.log"
    WORKER_LOGS+=("$WORKER_LOG")

    ARGS="--worker $i --total-workers $NUM_WORKERS --db $DB_PATH"
    if [ -n "$UNENRICHED_ONLY" ]; then
        ARGS="$ARGS $UNENRICHED_ONLY"
    fi
    if [ -n "$DRY_RUN" ]; then
        ARGS="$ARGS $DRY_RUN"
    fi

    echo "Starting worker $i..." | tee -a "$MAIN_LOG"
    python3 "$PIPELINE_DIR/enrich-tags.py" $ARGS > "$WORKER_LOG" 2>&1 &
    PIDS+=($!)
done

echo "" | tee -a "$MAIN_LOG"
echo "All $NUM_WORKERS workers started. PIDs: ${PIDS[*]}" | tee -a "$MAIN_LOG"
echo "Waiting for completion..." | tee -a "$MAIN_LOG"

# Wait for all workers
FAILED_WORKERS=0
for i in "${!PIDS[@]}"; do
    PID="${PIDS[$i]}"
    WORKER_NUM=$((i+1))
    if wait "$PID"; then
        LAST_LINE=$(tail -1 "${WORKER_LOGS[$i]}" 2>/dev/null || echo "")
        echo "Worker $WORKER_NUM complete: $LAST_LINE" | tee -a "$MAIN_LOG"
    else
        echo "Worker $WORKER_NUM FAILED (exit $?)" | tee -a "$MAIN_LOG"
        FAILED_WORKERS=$((FAILED_WORKERS+1))
    fi
done

echo "" | tee -a "$MAIN_LOG"
echo "======================================" | tee -a "$MAIN_LOG"

# Final stats from DB
ENRICHED=$(python3 -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
total = conn.execute('SELECT COUNT(*) FROM cdp_programs WHERE is_active=1').fetchone()[0]
tagged = conn.execute('SELECT COUNT(*) FROM cdp_programs WHERE is_active=1 AND tags IS NOT NULL AND tags != \"\"').fetchone()[0]
with_sector = conn.execute('SELECT COUNT(*) FROM cdp_programs WHERE is_active=1 AND sector IS NOT NULL').fetchone()[0]
print(f'Total={total} Tagged={tagged} WithSector={with_sector} Untagged={total-tagged}')
")
echo "Final DB state: $ENRICHED" | tee -a "$MAIN_LOG"
echo "Failed workers: $FAILED_WORKERS" | tee -a "$MAIN_LOG"
echo "Log: $MAIN_LOG" | tee -a "$MAIN_LOG"
echo "======================================" | tee -a "$MAIN_LOG"

if [ $FAILED_WORKERS -gt 0 ]; then
    exit 1
fi
exit 0
