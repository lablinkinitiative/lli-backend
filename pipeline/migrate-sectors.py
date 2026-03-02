#!/usr/bin/env python3
"""
migrate-sectors.py — Populate sector column for all existing programs.

Uses pipeline output files to map slugs → sector, then falls back to
slug-prefix inference. Run once after adding the sector column.
"""
import json
import sqlite3
import re
from pathlib import Path

DB_PATH = Path("/home/agent/data/lablink.db")
OUTPUT_DIR = Path(__file__).parent / "output"

FILENAME_TO_SECTOR = {
    "01-doe-national-labs": "doe_labs",
    "02-federal-science": "federal_science",
    "03-space-defense": "space_defense",
    "04-biomedical-health": "biomedical",
    "05-high-school": "high_school",
    "06-diversity-bridge": "diversity_bridge",
    "07-industry-tech": "industry_tech",
    "08-community-college": "community_college",
    "09-competitive-fellowships": "fellowships",
}


def infer_sector(slug: str, program_type: str, organization: str) -> str:
    s = slug.lower()
    org = (organization or "").lower()

    # DOE National Labs — specific lab abbreviations
    if any(s.startswith(p) for p in [
        "doe-", "suli-", "scgsr-", "nnsa-", "inl-", "ornl-", "llnl-", "sandia-",
        "pnnl-", "nrel-", "anl-", "lbnl-", "bnl-", "fermilab-", "slac-", "lanl-",
        "orau-", "orise-", "ames-lab-", "snl-", "tjnaf-", "srnl-"
    ]):
        return "doe_labs"
    if "national lab" in org or "department of energy" in org or org == "doe national labs":
        return "doe_labs"

    # Federal Science
    if any(s.startswith(p) for p in [
        "nsf-", "nih-", "noaa-", "epa-", "usda-", "usgs-", "nist-",
        "smithsonian-", "usaid-", "census-", "nps-", "fws-"
    ]):
        return "federal_science"

    # Space & Defense
    if any(s.startswith(p) for p in [
        "nasa-", "afrl-", "nreip-", "smart-", "dod-", "darpa-", "afosr-", "space-", "arpa-"
    ]):
        return "space_defense"

    # Biomedical
    if any(s.startswith(p) for p in [
        "hhmi-", "jackson-", "mayo-", "amgen-scholars", "surf-caltech",
        "mskcc-", "dana-farber-", "cold-spring-", "salk-"
    ]):
        return "biomedical"

    # Diversity & Equity
    if any(s.startswith(p) for p in [
        "marc-", "lsamp-", "mcnair-", "aises-", "sacnas-", "nnbms-", "abrcms-",
        "hacu-", "hbcu-", "trio-", "nsbe-", "swe-", "shpe-", "bridges-", "gen-10-"
    ]):
        return "diversity_bridge"

    # High School
    if any(s.startswith(p) for p in [
        "rsi-", "smash-", "primes-", "histep-", "high-school-", "ssp-", "hs-",
        "tasp-", "research-science-initiative"
    ]) or "-high-school" in s:
        return "high_school"

    # Industry: Energy & Climate
    if any(s.startswith(p) for p in [
        "tesla-", "nextera-", "next-era-", "sunrun-", "vestas-", "first-solar-",
        "chevron-", "exxon-", "bp-", "shell-", "halliburton-", "nrg-"
    ]):
        return "industry_energy"
    if "industry" in org and "energy" in org or "clean energy" in org:
        return "industry_energy"

    # Industry: Life Sciences / Biotech
    if any(s.startswith(p) for p in [
        "genentech-", "amgen-", "illumina-", "regeneron-", "biogen-",
        "vertex-", "crispr-", "10x-genomics-", "abbvie-", "merck-", "pfizer-"
    ]):
        return "industry_biotech"

    # Industry: Tech & Computing
    if any(s.startswith(p) for p in [
        "google-", "nvidia-", "microsoft-", "intel-", "boeing-", "lockheed-",
        "apple-", "meta-", "amazon-", "ibm-", "qualcomm-", "amd-", "salesforce-",
        "linkedin-", "uber-", "adobe-", "intuit-", "tsmc-", "broadcom-", "twitter-",
        "tiktok-", "snap-", "roblox-", "palantir-"
    ]):
        return "industry_tech"

    # Environmental
    if any(s.startswith(p) for p in [
        "edf-", "nrdc-", "sierra-club-", "wri-", "rmi-", "rocky-mountain-",
        "conservation-", "wwf-", "nature-conservancy-"
    ]):
        return "environmental"

    # Community College
    if any(s.startswith(p) for p in ["ccsep-", "year-up-", "ncas-", "cc-", "ptk-"]) \
            or "community-college" in s:
        return "community_college"

    # Fellowships (type-based first)
    if program_type in ("fellowship", "scholarship"):
        return "fellowships"
    if any(s.startswith(p) for p in [
        "goldwater-", "grfp-", "hertz-", "nsf-graduate-", "soros-", "churchill-",
        "knight-", "fulbright-", "barry-", "nsf-grfp", "doe-csgf"
    ]):
        return "fellowships"

    # Org-based fallbacks
    if "smithsonian" in org or "nsf" in org or "noaa" in org:
        return "federal_science"
    if "diversity" in org or "equity" in org or "bridge" in org:
        return "diversity_bridge"
    if "community college" in org:
        return "community_college"

    return "other"


def derive_categories(primary_sector: str, slug: str, eligibility_json: str,
                      program_type: str, stem_fields_json: str, organization: str) -> list:
    cats = set([primary_sector])
    s = slug.lower()
    org = (organization or "").lower()

    # Cross-list HS
    if primary_sector != "high_school" and ("-high-school" in s or "hs-" in s):
        cats.add("high_school")

    # Cross-list CC
    if primary_sector != "community_college":
        try:
            elig = json.loads(eligibility_json or "{}")
            if "community-college" in elig.get("education_level", []):
                cats.add("community_college")
        except Exception:
            pass
        if "community-college" in s or "community college" in org:
            cats.add("community_college")

    # Cross-list diversity
    if primary_sector != "diversity_bridge":
        div_kw = ["diversity", "underrepresented", "minority", "hbcu", "hacu",
                  "tribal", "first-gen", "women", "lsamp", "mcnair", "marc",
                  "aises", "sacnas", "nsbe", "shpe", "swe"]
        if any(k in s or k in org for k in div_kw):
            cats.add("diversity_bridge")

    # Cross-list fellowships
    if primary_sector != "fellowships" and program_type in ("fellowship", "scholarship"):
        cats.add("fellowships")

    # Cross-list biomedical
    if primary_sector != "biomedical":
        try:
            fields = json.loads(stem_fields_json or "[]")
            if any(f in ["biomedical", "public-health", "neuroscience"] for f in fields):
                cats.add("biomedical")
        except Exception:
            pass

    # Cross-list environmental
    if primary_sector != "environmental":
        try:
            fields = json.loads(stem_fields_json or "[]")
            if any(f in ["environmental-science", "geology"] for f in fields):
                cats.add("environmental")
        except Exception:
            pass

    return sorted(cats)


def main():
    # Build slug→sector map from pipeline output files
    slug_sector_map = {}
    for fname, sector in FILENAME_TO_SECTOR.items():
        fpath = OUTPUT_DIR / f"{fname}.json"
        if fpath.exists():
            try:
                programs = json.loads(fpath.read_text())
                for p in programs:
                    if p.get("slug"):
                        slug_sector_map[p["slug"]] = sector
            except Exception as e:
                print(f"  Warning: could not read {fpath}: {e}")

    print(f"Built slug→sector map: {len(slug_sector_map)} entries from pipeline output")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Ensure columns exist
    for col_sql in [
        "ALTER TABLE cdp_programs ADD COLUMN sector TEXT",
        "ALTER TABLE cdp_programs ADD COLUMN categories TEXT",
    ]:
        try:
            conn.execute(col_sql)
            conn.commit()
        except Exception:
            pass

    programs = conn.execute("SELECT * FROM cdp_programs").fetchall()
    print(f"Found {len(programs)} programs to migrate")

    updated = 0
    sector_counts = {}

    for p in programs:
        slug = p["slug"]
        # Determine sector: pipeline map → inference
        sector = (
            slug_sector_map.get(slug)
            or infer_sector(slug, p["program_type"] or "internship", p["organization"] or "")
        )

        categories = derive_categories(
            sector, slug,
            p["eligibility"], p["program_type"] or "internship",
            p["stem_fields"], p["organization"] or ""
        )

        conn.execute(
            "UPDATE cdp_programs SET sector = ?, categories = ? WHERE slug = ?",
            (sector, json.dumps(categories), slug)
        )
        sector_counts[sector] = sector_counts.get(sector, 0) + 1
        updated += 1

    conn.commit()
    conn.close()

    print(f"\nMigration complete: {updated} programs updated")
    print("\nSector distribution:")
    for sector, count in sorted(sector_counts.items(), key=lambda x: -x[1]):
        print(f"  {count:3d}  {sector}")


if __name__ == "__main__":
    main()
