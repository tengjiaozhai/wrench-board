#!/bin/bash
# V551 Vision Pipeline Runner + Monitor
# Usage: nohup bash run_v551_vision.sh &

LOG="/tmp/vision_v551_monitor.log"
LAST_COUNT_FILE="/tmp/v551_last_count"
echo "0" > "$LAST_COUNT_FILE"

echo "[$(date +%H:%M:%S)] Starting vision pipeline..." > "$LOG"

# Launch pipeline in background
cd /Users/shenmingjie/tinno/research/wrench-board
/Users/shenmingjie/tinno/research/wrench-board/.venv/bin/python -u -c "
import asyncio, sys, time
sys.path.insert(0, '.')
from pathlib import Path
from anthropic import AsyncAnthropic
from api.config import get_settings
from api.pipeline.schematic.orchestrator import ingest_schematic

settings = get_settings()
client = AsyncAnthropic(
    api_key=settings.anthropic_api_key,
    base_url=settings.anthropic_base_url if settings.anthropic_base_url else None,
)
pdf_path = Path('memory/v551/uploads/20260604T085241Z-schematic_pdf-V551_-.pdf')

t0 = time.time()
print(f'[{time.strftime(\"%H:%M:%S\")}] Pipeline started', flush=True)

async def run():
    graph = await ingest_schematic(
        device_slug='v551', pdf_path=pdf_path, client=client,
        model=settings.anthropic_model_main,
    )
    elapsed = time.time() - t0
    print(f'[{time.strftime(\"%H:%M:%S\")}] DONE in {elapsed:.0f}s nodes={len(graph.nodes)} edges={len(graph.edges)}', flush=True)

asyncio.run(run())
" >> "$LOG" 2>&1 &
PIPELINE_PID=$!

echo "[$(date +%H:%M:%S)] Pipeline PID: $PIPELINE_PID" >> "$LOG"

# Monitor loop
while true; do
  count=$(ls /Users/shenmingjie/tinno/research/wrench-board/memory/v551/schematic_pages/page_*.json 2>/dev/null | wc -l | tr -d ' ')
  latest=$(ls -t /Users/shenmingjie/tinno/research/wrench-board/memory/v551/schematic_pages/page_*.json 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "none")
  eg=$(ls /Users/shenmingjie/tinno/research/wrench-board/memory/v551/electrical_graph.json 2>/dev/null && echo "YES" || echo "NO")
  
  last_count=$(cat "$LAST_COUNT_FILE" 2>/dev/null || echo "0")
  
  if [ "$count" != "$last_count" ]; then
    echo "[$(date +%H:%M:%S)] PROGRESS ${last_count} -> ${count}/49 | latest: ${latest}" >> "$LOG"
    echo "$count" > "$LAST_COUNT_FILE"
  fi
  
  if [ "$eg" = "YES" ]; then
    echo "[$(date +%H:%M:%S)] COMPLETE electrical_graph.json generated!" >> "$LOG"
    break
  fi
  
  if ! ps -p $PIPELINE_PID > /dev/null 2>&1; then
    echo "[$(date +%H:%M:%S)] PROCESS ENDED (exit)" >> "$LOG"
    break
  fi
  
  sleep 30
done
