# LabLink Internship Pipeline — Agent Native

An agent-native STEM opportunity aggregation pipeline for LabLink Initiative.

## Architecture

No APIs. No scraping with Playwright or Selenium. Instead:

**Claude subagents do the research.**

The orchestrator deploys 9 parallel Claude agents, one per sector. Each agent uses web search and page extraction to find, read, and normalize real program data from official sources. This gives us:
- Deep extraction of actual eligibility, deadlines, stipends
- Ability to navigate any site structure (not just JSON APIs)
- Natural language interpretation of complex program requirements
- Scales to any new sector by adding a prompt file

Inspired by: https://github.com/fl-sean03/phd-internship-campaign

## Sectors

| # | Sector | Programs |
|---|--------|----------|
| 01 | DOE National Labs (SULI, CCI, SCGSR, lab-specific) | 15-25 |
| 02 | Federal Science Agencies (NSF, NIH, NOAA, EPA, USDA) | 18-25 |
| 03 | Space & Defense (NASA, AFRL, NREIP, DoD SMART) | 12-18 |
| 04 | Biomedical & Health (HHMI, Jackson Lab, Mayo, pharma) | 15-20 |
| 05 | High School Programs (RSI, PRIMES, HiSTEP, SMASH) | 18-25 |
| 06 | Diversity & Bridge (MARC, LSAMP, SACNAS, McNair, AISES) | 20-30 |
| 07 | Industry STEM (Google STEP, NVIDIA, Amgen Scholars) | 12-18 |
| 08 | Community College (CCI, CCSEP, NCAS, Year Up) | 10-15 |
| 09 | Competitive Fellowships (Goldwater, NSF GRFP, Hertz) | 15-20 |

## Usage

### Run full pipeline
```bash
./run-pipeline.sh
```

### Run specific sectors
```bash
./run-pipeline.sh --sectors 01,05,06
```

### Dry run (validate without calling agents)
```bash
./run-pipeline.sh --dry-run
```

### Skip DB upsert (just collect agent output)
```bash
./run-pipeline.sh --skip-upsert
```

### Upsert existing output to DB
```bash
python3 upsert.py --input output/all-programs.json
```

## Schedule

Runs weekly: **Monday 6:00 AM UTC**

The cron job drops a trigger file into `~/messages/inbox/` which wakes lab-link,
which processes it by calling `run-pipeline.sh`.

## Output

- `output/all-programs.json` — combined normalized output from all agents
- `output/01-doe-national-labs.json` — per-sector raw agent output
- `output/run-summary.json` — last run stats
- `output/pipeline-YYYYMMDD-HHMMSS.log` — full run log

## Adding New Sectors

1. Create `sectors/10-new-sector.md` following the existing prompt pattern
2. Include the required output schema in your prompt
3. The orchestrator picks it up automatically on next run

## CDP Integration

Results upsert directly into `cdp_programs` table in `/home/agent/data/lablink.db`.
The backend API serves these at `GET /api/programs` for the CDP frontend.
