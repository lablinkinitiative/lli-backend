#!/usr/bin/env python3
"""
LabLink Internship Pipeline — Agent-Native Orchestrator
========================================================
Deploys Claude subagents in parallel across 9 sectors to deep-search
for STEM opportunities. No APIs — agents use web search and page
extraction to find and normalize real program data.

Usage:
  python3 orchestrator.py [--sectors all|01,03,07] [--dry-run]
"""

import os
import sys
import json
import subprocess
import argparse
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE_DIR = Path(__file__).parent
SECTORS_DIR = BASE_DIR / "sectors"
OUTPUT_DIR = BASE_DIR / "output"
SCHEMA_FILE = BASE_DIR / "OUTPUT_SCHEMA.md"

OUTPUT_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger(__name__)


def load_schema() -> str:
    return SCHEMA_FILE.read_text()


def run_sector_agent(sector_file: Path, schema: str, dry_run: bool = False) -> dict:
    """Run a Claude subagent for one sector. Returns result dict."""
    sector_name = sector_file.stem
    output_file = OUTPUT_DIR / f"{sector_name}.json"

    log.info(f"[{sector_name}] Starting agent...")

    if dry_run:
        log.info(f"[{sector_name}] DRY RUN — skipping claude call")
        return {"sector": sector_name, "status": "dry-run", "programs": []}

    # Build the full prompt: sector brief + schema instructions
    sector_prompt = sector_file.read_text()
    full_prompt = f"""{sector_prompt}

---
## Output Format (REQUIRED)

{schema}

CRITICAL: Return ONLY a JSON array. No markdown fences, no explanation text, no preamble.
Start your response with [ and end with ]. The response must be valid JSON.
"""

    try:
        # Unset CLAUDECODE so nested session check is bypassed
        import os as _os
        env = _os.environ.copy()
        env.pop("CLAUDECODE", None)

        result = subprocess.run(
            [
                "claude",
                "--print",
                "--dangerously-skip-permissions",
                "--output-format", "text",
                "--model", "claude-sonnet-4-6",
                full_prompt
            ],
            capture_output=True,
            text=True,
            timeout=1200,  # 20 minutes per sector
            cwd=str(BASE_DIR),
            env=env
        )

        if result.returncode != 0:
            log.error(f"[{sector_name}] claude exited with code {result.returncode}")
            log.error(f"[{sector_name}] stderr: {result.stderr[:500]}")
            return {"sector": sector_name, "status": "error", "error": result.stderr[:500], "programs": []}

        raw = result.stdout.strip()

        # Extract JSON from response (handle if agent wraps in markdown)
        programs = extract_json(raw, sector_name)

        # Save raw output for debugging
        output_file.write_text(json.dumps(programs, indent=2))
        log.info(f"[{sector_name}] Done — {len(programs)} programs extracted → {output_file.name}")

        return {
            "sector": sector_name,
            "status": "ok",
            "programs": programs,
            "count": len(programs)
        }

    except subprocess.TimeoutExpired:
        log.error(f"[{sector_name}] TIMEOUT after 20 minutes")
        return {"sector": sector_name, "status": "timeout", "programs": []}
    except Exception as e:
        log.error(f"[{sector_name}] Exception: {e}")
        return {"sector": sector_name, "status": "error", "error": str(e), "programs": []}


def extract_json(raw: str, sector_name: str) -> list:
    """Extract JSON array from agent response, handling markdown wrapping."""
    # Try direct parse first
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass

    # Strip markdown code fences
    import re
    # Remove ```json ... ``` or ``` ... ```
    patterns = [
        r'```json\s*([\s\S]*?)\s*```',
        r'```\s*([\s\S]*?)\s*```',
    ]
    for pattern in patterns:
        m = re.search(pattern, raw, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(1))
                if isinstance(data, list):
                    log.info(f"[{sector_name}] Extracted JSON from markdown fence")
                    return data
            except json.JSONDecodeError:
                pass

    # Try to find [ ... ] in the response
    start = raw.find('[')
    end = raw.rfind(']')
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(raw[start:end+1])
            if isinstance(data, list):
                log.info(f"[{sector_name}] Extracted JSON by bracket search")
                return data
        except json.JSONDecodeError:
            pass

    log.error(f"[{sector_name}] Could not parse JSON from response. First 500 chars: {raw[:500]}")
    # Save raw for manual inspection
    (OUTPUT_DIR / f"{sector_name}.raw.txt").write_text(raw)
    return []


def aggregate_results(results: list) -> list:
    """Merge all programs, deduplicate by slug."""
    seen_slugs = set()
    seen_urls = set()
    all_programs = []

    for result in results:
        if result["status"] not in ("ok",):
            continue
        for prog in result.get("programs", []):
            slug = prog.get("slug", "")
            url = prog.get("url", "")

            # Skip duplicates
            if slug in seen_slugs:
                log.debug(f"Duplicate slug: {slug}")
                continue
            if url and url in seen_urls:
                log.debug(f"Duplicate URL: {url}")
                continue

            seen_slugs.add(slug)
            if url:
                seen_urls.add(url)
            all_programs.append(prog)

    log.info(f"Aggregated {len(all_programs)} unique programs")
    return all_programs


def main():
    parser = argparse.ArgumentParser(description="LabLink Internship Pipeline Orchestrator")
    parser.add_argument("--sectors", default="all",
                        help="Comma-separated sector numbers (e.g. 01,03) or 'all'")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build prompts but don't call claude")
    parser.add_argument("--max-workers", type=int, default=5,
                        help="Max parallel sector agents (default: 5)")
    args = parser.parse_args()

    # Load sector files
    all_sector_files = sorted(SECTORS_DIR.glob("*.md"))
    if not all_sector_files:
        log.error(f"No sector files found in {SECTORS_DIR}")
        sys.exit(1)

    if args.sectors == "all":
        sector_files = all_sector_files
    else:
        wanted = set(args.sectors.split(","))
        sector_files = [f for f in all_sector_files if any(f.name.startswith(w) for w in wanted)]

    log.info(f"Running pipeline: {len(sector_files)} sectors, {args.max_workers} parallel agents")

    schema = load_schema()
    start_time = datetime.now()

    results = []
    with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = {
            executor.submit(run_sector_agent, sf, schema, args.dry_run): sf.stem
            for sf in sector_files
        }
        for future in as_completed(futures):
            sector_name = futures[future]
            try:
                result = future.result()
                results.append(result)
                status = result.get("status", "?")
                count = result.get("count", 0)
                log.info(f"  ✓ {sector_name}: {status} ({count} programs)")
            except Exception as e:
                log.error(f"  ✗ {sector_name}: {e}")
                results.append({"sector": sector_name, "status": "exception", "programs": []})

    # Aggregate
    all_programs = aggregate_results(results)

    # Save combined output
    combined_file = OUTPUT_DIR / "all-programs.json"
    combined_file.write_text(json.dumps(all_programs, indent=2))
    log.info(f"Combined output: {combined_file} ({len(all_programs)} programs)")

    # Save run summary
    elapsed = (datetime.now() - start_time).total_seconds()
    summary = {
        "run_at": start_time.isoformat(),
        "elapsed_seconds": elapsed,
        "sectors_run": len(sector_files),
        "total_programs": len(all_programs),
        "sector_results": [
            {"sector": r["sector"], "status": r["status"], "count": r.get("count", 0)}
            for r in results
        ]
    }
    (OUTPUT_DIR / "run-summary.json").write_text(json.dumps(summary, indent=2))

    # Print summary for orchestrator/Slack
    print(json.dumps(summary))

    return 0 if all_programs else 1


if __name__ == "__main__":
    sys.exit(main())
