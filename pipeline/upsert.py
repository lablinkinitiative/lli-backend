#!/usr/bin/env python3
"""
LabLink Internship Pipeline — DB Upsert
========================================
Reads agent output JSON, normalizes it, and upserts into cdp_programs.

Usage:
  python3 upsert.py [--input output/all-programs.json] [--db /path/to/lablink.db]
  python3 upsert.py --input output/01-doe-national-labs.json
"""

import json
import sqlite3
import argparse
import logging
import re
import sys
from pathlib import Path
from datetime import datetime, date

BASE_DIR = Path(__file__).parent
DEFAULT_DB = Path("/home/agent/data/lablink.db")
DEFAULT_INPUT = BASE_DIR / "output" / "all-programs.json"

VALID_TYPES = {"internship", "fellowship", "scholarship", "workshop", "research", "other"}
VALID_FIELDS = {
    "biology", "chemistry", "physics", "cs", "engineering", "math",
    "environmental-science", "public-health", "neuroscience", "materials-science",
    "astronomy", "geology", "data-science", "biomedical", "mechanical-engineering",
    "electrical-engineering", "chemical-engineering", "civil-engineering",
    "aerospace", "nuclear", "other"
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger(__name__)


def normalize_slug(slug: str) -> str:
    """Make slug safe and unique-friendly."""
    slug = slug.lower().strip()
    slug = re.sub(r'[^a-z0-9-]', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return slug[:60]


def normalize_date(val) -> str | None:
    """Normalize date to YYYY-MM-DD or None."""
    if not val:
        return None
    if isinstance(val, (int, float)):
        return None
    s = str(val).strip()
    # Already YYYY-MM-DD
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return s
    # Try common formats
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%Y/%m/%d", "%d %B %Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Month Year format — use first of month
    m = re.match(r'^([A-Za-z]+)\s+(\d{4})$', s)
    if m:
        try:
            return datetime.strptime(f"01 {s}", "%d %B %Y").strftime("%Y-%m-%d")
        except ValueError:
            pass
    log.debug(f"Could not parse date: {val!r}")
    return None


def normalize_fields(raw_fields) -> str:
    """Normalize stem_fields to JSON array string."""
    if not raw_fields:
        return json.dumps(["other"])

    if isinstance(raw_fields, str):
        try:
            raw_fields = json.loads(raw_fields)
        except json.JSONDecodeError:
            raw_fields = [f.strip() for f in raw_fields.split(",")]

    if not isinstance(raw_fields, list):
        return json.dumps(["other"])

    normalized = []
    for f in raw_fields:
        f = f.lower().strip().replace(" ", "-")
        if f in VALID_FIELDS:
            normalized.append(f)
        elif f in ("computer-science", "computer science"):
            normalized.append("cs")
        elif f in ("env-science", "environmental"):
            normalized.append("environmental-science")
        elif "engineer" in f:
            normalized.append("engineering")
        elif f in ("bio", "biochem", "biochemistry"):
            normalized.append("biology")
        elif f in ("chem"):
            normalized.append("chemistry")

    return json.dumps(normalized if normalized else ["other"])


def normalize_eligibility(raw_elig) -> str | None:
    """Normalize eligibility to JSON string."""
    if not raw_elig:
        return None
    if isinstance(raw_elig, str):
        # Already a JSON string?
        try:
            parsed = json.loads(raw_elig)
            return json.dumps(parsed)
        except json.JSONDecodeError:
            return json.dumps({"notes": raw_elig})
    if isinstance(raw_elig, dict):
        return json.dumps(raw_elig)
    return json.dumps({"notes": str(raw_elig)})


def normalize_remote(val) -> int:
    """Normalize remote to 0/1."""
    if isinstance(val, bool):
        return 1 if val else 0
    if isinstance(val, int):
        return 1 if val else 0
    if isinstance(val, str):
        return 1 if val.lower() in ("true", "yes", "1", "remote") else 0
    return 0


def normalize_program(prog: dict) -> dict | None:
    """Normalize a raw program dict to DB schema. Returns None if invalid."""
    slug = prog.get("slug", "").strip()
    title = prog.get("title", "").strip()
    organization = prog.get("organization", "").strip()

    if not slug or not title or not organization:
        log.warning(f"Skipping program missing required fields: {prog.get('title', '?')}")
        return None

    slug = normalize_slug(slug)
    if not slug:
        log.warning(f"Empty slug after normalization: {prog.get('title')}")
        return None

    program_type = prog.get("program_type", "internship").lower()
    if program_type not in VALID_TYPES:
        program_type = "other"

    url = prog.get("url", "").strip()
    if url and not url.startswith("http"):
        url = "https://" + url

    return {
        "slug": slug,
        "title": title[:255],
        "organization": organization[:255],
        "description": (prog.get("description") or "")[:2000],
        "program_type": program_type,
        "stem_fields": normalize_fields(prog.get("stem_fields")),
        "eligibility": normalize_eligibility(prog.get("eligibility")),
        "deadline": normalize_date(prog.get("deadline")),
        "start_date": normalize_date(prog.get("start_date")),
        "end_date": normalize_date(prog.get("end_date")),
        "stipend": (str(prog.get("stipend") or "")[:200]) or None,
        "location": (str(prog.get("location") or "")[:255]) or None,
        "remote": normalize_remote(prog.get("remote", False)),
        "url": url[:500] if url else None,
        "is_active": 1,
    }


def upsert_programs(programs: list, db_path: Path) -> dict:
    """Upsert programs into cdp_programs table."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    inserted = 0
    updated = 0
    skipped = 0
    errors = 0

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    for prog_raw in programs:
        prog = normalize_program(prog_raw)
        if not prog:
            skipped += 1
            continue

        try:
            existing = conn.execute(
                "SELECT id FROM cdp_programs WHERE slug = ?", (prog["slug"],)
            ).fetchone()

            if existing:
                # Update existing record (preserve id, created_at)
                conn.execute("""
                    UPDATE cdp_programs SET
                        title = ?, organization = ?, description = ?,
                        program_type = ?, stem_fields = ?, eligibility = ?,
                        deadline = ?, start_date = ?, end_date = ?,
                        stipend = ?, location = ?, remote = ?, url = ?,
                        is_active = ?, updated_at = ?
                    WHERE slug = ?
                """, (
                    prog["title"], prog["organization"], prog["description"],
                    prog["program_type"], prog["stem_fields"], prog["eligibility"],
                    prog["deadline"], prog["start_date"], prog["end_date"],
                    prog["stipend"], prog["location"], prog["remote"], prog["url"],
                    prog["is_active"], now,
                    prog["slug"]
                ))
                updated += 1
            else:
                conn.execute("""
                    INSERT INTO cdp_programs
                        (slug, title, organization, description, program_type,
                         stem_fields, eligibility, deadline, start_date, end_date,
                         stipend, location, remote, url, is_active, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    prog["slug"], prog["title"], prog["organization"], prog["description"],
                    prog["program_type"], prog["stem_fields"], prog["eligibility"],
                    prog["deadline"], prog["start_date"], prog["end_date"],
                    prog["stipend"], prog["location"], prog["remote"], prog["url"],
                    prog["is_active"], now, now
                ))
                inserted += 1

        except sqlite3.IntegrityError as e:
            log.warning(f"IntegrityError on {prog['slug']}: {e}")
            errors += 1
        except Exception as e:
            log.error(f"Error upserting {prog['slug']}: {e}")
            errors += 1

    conn.commit()
    conn.close()

    total = conn.execute("SELECT COUNT(*) FROM cdp_programs").fetchone()[0] if False else None

    # Re-open to get total count
    conn2 = sqlite3.connect(str(db_path))
    total = conn2.execute("SELECT COUNT(*) FROM cdp_programs WHERE is_active = 1").fetchone()[0]
    conn2.close()

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "total_active": total,
    }


def main():
    parser = argparse.ArgumentParser(description="LabLink Internship Pipeline DB Upsert")
    parser.add_argument("--input", default=str(DEFAULT_INPUT),
                        help="Input JSON file (agent output)")
    parser.add_argument("--db", default=str(DEFAULT_DB),
                        help="SQLite database path")
    parser.add_argument("--dry-run", action="store_true",
                        help="Normalize but don't write to DB")
    args = parser.parse_args()

    input_file = Path(args.input)
    if not input_file.exists():
        log.error(f"Input file not found: {input_file}")
        sys.exit(1)

    programs = json.loads(input_file.read_text())
    if not isinstance(programs, list):
        log.error(f"Expected JSON array, got {type(programs)}")
        sys.exit(1)

    log.info(f"Loaded {len(programs)} programs from {input_file}")

    if args.dry_run:
        valid = 0
        for p in programs:
            n = normalize_program(p)
            if n:
                valid += 1
                log.info(f"  ✓ {n['slug']} — {n['title'][:50]}")
            else:
                log.warning(f"  ✗ INVALID: {p.get('title', '?')}")
        log.info(f"Dry run: {valid}/{len(programs)} valid")
        return

    db_path = Path(args.db)
    if not db_path.exists():
        log.error(f"Database not found: {db_path}")
        sys.exit(1)

    stats = upsert_programs(programs, db_path)
    log.info(f"Upsert complete: {stats}")
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
