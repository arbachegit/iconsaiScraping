#!/bin/bash
# =============================================
# IconsAI - Emendas Collection Script
# Run all emendas sources sequentially
#
# Usage (on remote server):
#   cd /opt/iconsai-scraping
#   bash scripts/collect_emendas_all.sh
#
# Usage (single source):
#   cd /opt/iconsai-scraping
#   PYTHONPATH=. python3 scheduler/emendas_subnacionais_collector.py --source tesouro_transparente
#
# Usage (dry run):
#   PYTHONPATH=. python3 scheduler/emendas_subnacionais_collector.py --source tesouro_transparente --dry-run
# =============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

export PYTHONPATH="$PROJECT_DIR"

echo "=========================================="
echo "  IconsAI Emendas Collection"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# Priority order: largest/most important sources first
SOURCES=(
    "tesouro_transparente"
    "portal_transparencia_2024"
    "portal_transparencia_2025"
    "portal_transparencia_2026"
    "go_estado"
    "mg_estado"
    "ba_estado"
    "pr_estado"
    "rj_capital"
    "sp_capital"
    "bh_municipal"
)

TOTAL_FETCHED=0
TOTAL_INSERTED=0
ERRORS=0

for src in "${SOURCES[@]}"; do
    echo ""
    echo "--- Collecting: $src ---"
    echo "Start: $(date '+%H:%M:%S')"

    if python3 scheduler/emendas_subnacionais_collector.py --source "$src" 2>&1; then
        echo "Done: $(date '+%H:%M:%S')"
    else
        echo "ERROR on $src at $(date '+%H:%M:%S')"
        ERRORS=$((ERRORS + 1))
    fi

    # Rate limiting between sources
    echo "Waiting 5s before next source..."
    sleep 5
done

echo ""
echo "=========================================="
echo "  Collection Complete"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Errors: $ERRORS / ${#SOURCES[@]}"
echo "=========================================="
