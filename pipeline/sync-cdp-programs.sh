#!/usr/bin/env bash
# sync-cdp-programs.sh — Sync pipeline programs from API → CDP app → Vercel deploy
# Run after the internship pipeline to push updated programs to cdp.lablinkinitiative.org
set -euo pipefail

API_URL="https://app.lablinkinitiative.org/api/cdp/export/cdp-format"
CDP_APP_DIR="$HOME/repos/lli-cdp-app"
PROGRAMS_JSON="$CDP_APP_DIR/src/data/programs.json"
VERCEL_TOKEN=$(cat "$HOME/bootstrap/credentials/vercel-token.txt" | tr -d '\n\r')
TEAM_ID="team_jFM7k4eus2gDaSNx7oqkjmgp"
PROJECT_NAME="lli-cdp-app"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "Fetching programs from API..."
curl -sf "$API_URL" -o /tmp/cdp-programs-api.json
TOTAL=$(python3 -c "import json; d=json.load(open('/tmp/cdp-programs-api.json')); print(d['total'])")
log "Got $TOTAL programs from API"

log "Updating programs.json..."
python3 << 'PYEOF'
import json, sys

with open('/tmp/cdp-programs-api.json') as f:
    api_data = json.load(f)

output = {
    "meta": {
        "version": "3.0.0",
        "source": "LabLink CDP API + Pipeline",
        "generatedAt": api_data.get("generatedAt", ""),
        "count": api_data["total"]
    },
    "programs": api_data["programs"]
}

with open('/home/agent/repos/lli-cdp-app/src/data/programs.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f"Wrote {api_data['total']} programs to programs.json")
PYEOF

log "Building CDP app..."
cd "$CDP_APP_DIR"
npm run build 2>&1 | tail -5

log "Deploying to Vercel..."
python3 << PYEOF
import os, json, hashlib, urllib.request, urllib.error
from pathlib import Path

VERCEL_TOKEN = "$VERCEL_TOKEN"
TEAM_ID = "$TEAM_ID"
PROJECT_NAME = "$PROJECT_NAME"
DIST_DIR = Path("$CDP_APP_DIR/dist")

def upload_bytes(content, rel_path):
    sha = hashlib.sha1(content).hexdigest()
    req = urllib.request.Request(
        f'https://api.vercel.com/v2/files?teamId={TEAM_ID}',
        data=content,
        headers={
            'Authorization': f'Bearer {VERCEL_TOKEN}',
            'x-vercel-digest': sha,
            'Content-Length': str(len(content))
        },
        method='POST'
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        if e.code != 409: raise  # 409 = already exists, OK
    return {'file': rel_path, 'sha': sha, 'size': len(content)}

def upload_file(path, rel_path):
    with open(path, 'rb') as f:
        return upload_bytes(f.read(), rel_path)

files = []
for p in DIST_DIR.rglob('*'):
    if p.is_file():
        rel = str(p.relative_to(DIST_DIR))
        files.append(upload_file(p, rel))

# Upload minimal vercel.json with ONLY the SPA rewrite (no buildCommand — avoids re-build trigger)
spa_vercel = json.dumps({"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]}).encode()
files.append(upload_bytes(spa_vercel, 'vercel.json'))

print(f"Uploaded {len(files)} files (incl. vercel.json for SPA routing)")

deploy_data = {
    "name": PROJECT_NAME,
    "files": files,
    "target": "production",
    "routes": [
        {"handle": "filesystem"},
        {"src": "/(.*)", "dest": "/index.html"}
    ]
}

req = urllib.request.Request(
    f'https://api.vercel.com/v13/deployments?teamId={TEAM_ID}&forceNew=1',
    data=json.dumps(deploy_data).encode(),
    headers={'Authorization': f'Bearer {VERCEL_TOKEN}', 'Content-Type': 'application/json'},
    method='POST'
)
resp = urllib.request.urlopen(req)
result = json.loads(resp.read())
print(f"Deployment: {result.get('url')} — Status: {result.get('status')}")
PYEOF

log "CDP sync complete. Programs live at cdp.lablinkinitiative.org"
