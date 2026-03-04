#!/usr/bin/env python3
"""
LabLink CDP — Program Tag Enrichment
=====================================
Reads programs from cdp_programs, uses Claude to generate structured tags,
and writes tags back to DB. Also backfills sector/categories for older programs.

Usage:
  python3 enrich-tags.py --worker 1 --total-workers 5 [--db /path/to/lablink.db]
  python3 enrich-tags.py --offset 0 --limit 80 [--db /path/to/lablink.db]
  python3 enrich-tags.py --ids 1,2,3,4,5 [--db /path/to/lablink.db]
  python3 enrich-tags.py --unenriched-only [--db /path/to/lablink.db]
"""

import os
import sys
import json
import sqlite3
import argparse
import subprocess
import logging
import time
import re
from pathlib import Path
from datetime import datetime

DB_PATH = Path("/home/agent/data/lablink.db")
CLAUDE_BIN = Path(os.environ.get("CLAUDE_BIN", os.path.expanduser("~/.local/bin/claude")))
BATCH_SIZE = 10  # programs per Claude call

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%H:%M:%S"
)

SECTOR_KEYWORDS = {
    "doe_labs": ["department of energy", "doe", "national laboratory", "oak ridge", "argonne",
                 "brookhaven", "fermilab", "ames laboratory", "sandia", "lawrence livermore",
                 "lawrence berkeley", "pacific northwest", "slac", "nrel", "osti"],
    "federal_science": ["nsf", "national science foundation", "nih", "noaa", "usgs", "epa",
                        "department of agriculture", "usda", "nist", "reu", "research experience"],
    "space_defense": ["nasa", "spacex", "aerospace", "defense", "army", "navy", "air force",
                      "darpa", "northrop", "lockheed", "boeing defense", "space force"],
    "biomedical": ["nih", "niaid", "nci", "national institutes of health", "hospital", "clinical",
                   "medical", "health science", "pharmacy", "biotech", "pharmaceutical"],
    "high_school": ["high school", "9th grade", "10th grade", "11th grade", "12th grade",
                    "pre-college", "secondary school", "summer bridge", "youth", "teen"],
    "diversity_bridge": ["underrepresented", "minority", "diversity", "first-generation",
                         "hbcu", "hispanic", "latinx", "native american", "women in stem",
                         "bridges to", "pathway", "access program"],
    "industry_tech": ["google", "microsoft", "amazon", "apple", "meta", "ibm", "intel",
                      "qualcomm", "nvidia", "industry", "corporate", "startup", "company"],
    "community_college": ["community college", "2-year", "associate degree", "transfer",
                          "cc program", "junior college"],
    "fellowships": ["fellowship", "scholar", "award", "prize", "graduate fellowship",
                    "postdoctoral", "phd", "doctoral", "grfp", "hertz", "rhodes", "fulbright"],
}


def get_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def infer_sector(program: dict) -> str | None:
    """Infer sector from program text if not set."""
    text = " ".join([
        (program["title"] or "").lower(),
        (program["organization"] or "").lower(),
        (program["description"] or "").lower(),
    ])
    scores = {}
    for sector, keywords in SECTOR_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > 0:
            scores[sector] = score
    if not scores:
        return None
    return max(scores, key=scores.get)


def get_programs_batch(conn: sqlite3.Connection, offset: int, limit: int) -> list[dict]:
    """Get a batch of programs by offset/limit ordered by id."""
    rows = conn.execute(
        "SELECT * FROM cdp_programs WHERE is_active = 1 ORDER BY id LIMIT ? OFFSET ?",
        (limit, offset)
    ).fetchall()
    return [dict(row) for row in rows]


def get_programs_by_ids(conn: sqlite3.Connection, ids: list[int]) -> list[dict]:
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT * FROM cdp_programs WHERE id IN ({placeholders})", ids
    ).fetchall()
    return [dict(row) for row in rows]


def call_claude_for_tags(programs: list[dict], worker_id: int, log: logging.Logger) -> list[dict | None]:
    """Call Claude to generate tags for a batch of programs.
    Returns list of tag dicts (one per program, None if failed)."""

    programs_text = ""
    for i, p in enumerate(programs):
        programs_text += f"""
Program {i+1}:
  Title: {p['title']}
  Organization: {p['organization']}
  Type: {p['program_type']}
  STEM Fields: {p['stem_fields']}
  Description: {(p['description'] or '')[:500]}
  Stipend: {p['stipend'] or 'not specified'}
  Location: {p['location'] or 'not specified'}
  Remote: {'yes' if p['remote'] else 'no'}
  Eligibility: {p['eligibility'] or 'not specified'}
  Sector: {p['sector'] or 'unknown'}
---"""

    prompt = f"""You are a STEM opportunity database tagger. Analyze each program below and return structured tags as a JSON array.

PROGRAMS TO TAG:
{programs_text}

For each program, generate a tags object with these fields:

- career_stage: array of applicable values from: ["high_school", "undergraduate", "graduate", "phd", "postdoc", "professional", "any"]
- benefits: array of applicable values from: ["stipend", "housing", "travel_funding", "academic_credit", "health_insurance", "meals", "equipment_access"]
- duration: array of applicable values from: ["summer", "semester", "year_round", "10_weeks", "8_weeks", "12_weeks", "part_time"]
- location_type: array of applicable values from: ["in_person", "remote", "hybrid"]
- focus_type: array of applicable values from: ["wet_lab", "computational", "clinical", "field_research", "policy", "engineering", "industry", "teaching", "design"]
- special_eligibility: array of applicable values from: ["underrepresented_minorities", "first_generation", "women_in_stem", "veterans", "disability", "us_citizen_only", "open_international", "need_based"]
- keywords: array of applicable values from: ["paid", "prestigious", "highly_competitive", "beginner_friendly", "renewable", "needs_recommendations", "needs_transcript", "needs_gpa_3_0", "federal_program", "industry_partner", "research_intensive"]
- inferred_sector: the most appropriate sector from: ["doe_labs", "federal_science", "space_defense", "biomedical", "high_school", "diversity_bridge", "industry_tech", "community_college", "fellowships"] — use null if none fit

Rules:
- Include "stipend" in benefits if stipend field has any dollar amount
- Include "paid" in keywords if stipend exists
- Include "us_citizen_only" if description mentions citizenship requirement
- Include "prestigious" for NSF, NIH, NASA, DOE, Hertz, Rhodes, Fulbright, etc.
- Be conservative — only include tags that are clearly supported by the text

Return ONLY a valid JSON array with exactly {len(programs)} objects in the same order as the programs above.
Start with [ and end with ]. No markdown, no explanation.

Example for one program:
{{"career_stage":["undergraduate"],"benefits":["stipend","housing"],"duration":["summer","10_weeks"],"location_type":["in_person"],"focus_type":["wet_lab","computational"],"special_eligibility":["us_citizen_only"],"keywords":["paid","prestigious","needs_recommendations","federal_program"],"inferred_sector":"federal_science"}}
"""

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    try:
        result = subprocess.run(
            [
                str(CLAUDE_BIN),
                "--print",
                "--dangerously-skip-permissions",
                "--output-format", "text",
                "--model", "claude-haiku-4-5-20251001",
                prompt
            ],
            capture_output=True,
            text=True,
            timeout=120,
            env=env
        )
        output = result.stdout.strip()
        if not output:
            log.error(f"Empty output from Claude. stderr: {result.stderr[:200]}")
            return [None] * len(programs)

        # Extract JSON array from output
        # Find first [ and last ]
        start = output.find("[")
        end = output.rfind("]")
        if start == -1 or end == -1:
            log.error(f"No JSON array found in output: {output[:300]}")
            return [None] * len(programs)

        json_str = output[start:end+1]
        tags_list = json.loads(json_str)

        if len(tags_list) != len(programs):
            log.warning(f"Tag count mismatch: got {len(tags_list)}, expected {len(programs)}")
            # Pad with Nones if needed
            while len(tags_list) < len(programs):
                tags_list.append(None)
            tags_list = tags_list[:len(programs)]

        return tags_list

    except subprocess.TimeoutExpired:
        log.error("Claude call timed out")
        return [None] * len(programs)
    except json.JSONDecodeError as e:
        log.error(f"JSON parse error: {e}. Output: {output[:300]}")
        return [None] * len(programs)
    except Exception as e:
        log.error(f"Unexpected error calling Claude: {e}")
        return [None] * len(programs)


def update_program_tags(conn: sqlite3.Connection, program_id: int, tags: dict, inferred_sector: str | None, program: dict):
    """Write tags and backfill sector/categories to DB."""
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    tags_json = json.dumps(tags)

    # Determine sector: keep existing, or use inferred
    existing_sector = program.get("sector")
    sector_to_use = existing_sector or inferred_sector or infer_sector(program)

    # categories is just [sector] if we have one
    existing_categories = program.get("categories")
    categories_to_use = existing_categories
    if not existing_categories and sector_to_use:
        categories_to_use = json.dumps([sector_to_use])

    for attempt in range(3):
        try:
            conn.execute("""
                UPDATE cdp_programs SET
                    tags = ?,
                    tags_enriched_at = ?,
                    sector = COALESCE(sector, ?),
                    categories = COALESCE(categories, ?),
                    updated_at = ?
                WHERE id = ?
            """, (tags_json, now, sector_to_use, categories_to_use, now, program_id))
            conn.commit()
            return True
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise
    return False


def enrich_range(programs: list[dict], worker_id: int, log: logging.Logger) -> dict:
    """Process programs list — calls Claude in batches of BATCH_SIZE."""
    db = get_db(DB_PATH)
    enriched = 0
    failed = 0
    skipped = 0

    batches = [programs[i:i+BATCH_SIZE] for i in range(0, len(programs), BATCH_SIZE)]
    log.info(f"Processing {len(programs)} programs in {len(batches)} batches of {BATCH_SIZE}")

    for batch_idx, batch in enumerate(batches):
        log.info(f"Batch {batch_idx+1}/{len(batches)}: programs {batch[0]['id']}–{batch[-1]['id']}")

        tags_list = call_claude_for_tags(batch, worker_id, log)

        for program, tags in zip(batch, tags_list):
            if tags is None:
                log.warning(f"  ✗ {program['title'][:50]} — no tags generated")
                failed += 1
                continue

            # Extract inferred_sector from tags (not a top-level tag field)
            inferred_sector = tags.pop("inferred_sector", None)

            ok = update_program_tags(db, program["id"], tags, inferred_sector, program)
            if ok:
                log.info(f"  ✓ [{program['id']}] {program['title'][:50]}")
                enriched += 1
            else:
                log.error(f"  ✗ [{program['id']}] DB write failed")
                failed += 1

        # Brief pause between batches to avoid overloading
        if batch_idx < len(batches) - 1:
            time.sleep(2)

    db.close()

    return {
        "worker": worker_id,
        "total": len(programs),
        "enriched": enriched,
        "failed": failed,
        "skipped": skipped,
    }


def main():
    global DB_PATH
    parser = argparse.ArgumentParser(description="CDP Program Tag Enrichment")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path")
    parser.add_argument("--worker", type=int, default=1, help="Worker number (1-based)")
    parser.add_argument("--total-workers", type=int, default=1, help="Total number of workers")
    parser.add_argument("--offset", type=int, help="Manual offset (overrides worker/total-workers)")
    parser.add_argument("--limit", type=int, help="Manual limit (overrides worker/total-workers)")
    parser.add_argument("--ids", help="Comma-separated list of program IDs to process")
    parser.add_argument("--unenriched-only", action="store_true", help="Only process programs without tags")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be processed, don't write")
    args = parser.parse_args()

    DB_PATH = Path(args.db)

    # Setup logging with worker ID in format
    log = logging.getLogger(f"worker-{args.worker}")
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        f"%(asctime)s [w{args.worker}] %(levelname)s %(message)s",
        datefmt="%H:%M:%S"
    ))
    log.addHandler(handler)
    log.setLevel(logging.INFO)

    conn = get_db(DB_PATH)

    # Determine which programs to process
    if args.ids:
        id_list = [int(x.strip()) for x in args.ids.split(",")]
        programs = get_programs_by_ids(conn, id_list)
        log.info(f"Processing {len(programs)} programs by ID")
    elif args.offset is not None and args.limit is not None:
        programs = get_programs_batch(conn, args.offset, args.limit)
        log.info(f"Processing {len(programs)} programs at offset {args.offset}")
    elif args.unenriched_only:
        rows = conn.execute(
            "SELECT * FROM cdp_programs WHERE is_active = 1 AND (tags IS NULL OR tags = '') ORDER BY id"
        ).fetchall()
        programs = [dict(r) for r in rows]
        log.info(f"Processing {len(programs)} unenriched programs")
    else:
        # Partition by worker number
        total = conn.execute("SELECT COUNT(*) FROM cdp_programs WHERE is_active = 1").fetchone()[0]
        per_worker = (total + args.total_workers - 1) // args.total_workers
        offset = (args.worker - 1) * per_worker
        programs = get_programs_batch(conn, offset, per_worker)
        log.info(f"Worker {args.worker}/{args.total_workers}: programs {offset}–{offset+len(programs)-1} ({len(programs)} total)")

    conn.close()

    if not programs:
        log.info("No programs to process")
        print(json.dumps({"worker": args.worker, "total": 0, "enriched": 0, "failed": 0, "skipped": 0}))
        return

    if args.dry_run:
        log.info(f"DRY RUN: would process {len(programs)} programs")
        for p in programs[:5]:
            log.info(f"  [{p['id']}] {p['title'][:60]} (sector={p['sector']}, tags={'yes' if p['tags'] else 'no'})")
        if len(programs) > 5:
            log.info(f"  ... and {len(programs) - 5} more")
        return

    stats = enrich_range(programs, args.worker, log)
    log.info(f"Done: {stats}")
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
