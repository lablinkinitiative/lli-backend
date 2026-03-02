# Internship Pipeline — Output Schema

Every sector agent MUST return a JSON array. No markdown, no explanation, only valid JSON.

## Format

```json
[
  {
    "slug": "unique-kebab-case-id",
    "title": "Full Program Name",
    "organization": "Organization Full Name",
    "description": "2-4 sentence description of the program. What students do, where, what they learn.",
    "program_type": "internship|fellowship|scholarship|workshop|research|other",
    "stem_fields": ["biology","chemistry","physics","cs","engineering","math","environmental-science","public-health","neuroscience","materials-science","astronomy","geology","data-science","biomedical","mechanical-engineering","electrical-engineering","chemical-engineering","civil-engineering","aerospace","nuclear","other"],
    "eligibility": {
      "education_level": ["high-school","community-college","undergraduate","graduate","phd","postdoc"],
      "gpa_min": 3.0,
      "citizenship": "US citizen or permanent resident",
      "year": ["sophomore","junior","senior"],
      "age_min": null,
      "age_max": null,
      "notes": "Any other eligibility notes"
    },
    "deadline": "YYYY-MM-DD or null if rolling/unknown",
    "start_date": "YYYY-MM-DD or null",
    "end_date": "YYYY-MM-DD or null",
    "duration": "10 weeks | 8-12 weeks | 1 year | etc.",
    "stipend": "$600/week | $5,000 total | unpaid | etc.",
    "location": "City, State | Various US universities | Remote | National Laboratories",
    "remote": false,
    "url": "https://official-program-url.gov",
    "tags": ["paid","federal","summer","research","undergrad","high-school","diversity","competitive"]
  }
]
```

## Rules
- `slug` must be globally unique, lowercase, hyphenated, max 60 chars
- `stem_fields` must be a JSON array of strings from the list above
- `eligibility` must be a JSON object (not a string)
- `deadline` must be ISO date (YYYY-MM-DD) or null
- `remote` must be boolean (true/false)
- `url` must be the REAL official program URL — verify it loads
- Include AT LEAST 15 programs per sector
- Do NOT include programs you cannot verify exist with a working URL
- Do NOT invent or hallucinate programs
