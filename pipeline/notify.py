#!/usr/bin/env python3
"""
LabLink Internship Pipeline — Slack Notification
=================================================
Posts pipeline run results to Slack.

Usage:
  python3 notify.py --summary '{"total_programs":150,...}' --upsert-stats '{"inserted":50,...}'
"""

import json
import argparse
import urllib.request
import sys
from pathlib import Path

CREDS_FILE = Path("/home/agent/bootstrap/credentials/slack-credentials.env")
SLACK_CHANNEL = "C0AF9DAR5L5"


def load_token() -> str:
    for line in CREDS_FILE.read_text().splitlines():
        line = line.strip().strip('\r')
        if line.startswith('SLACK_BOT_TOKEN='):
            return line.split('=', 1)[1].strip()
    raise ValueError("SLACK_BOT_TOKEN not found in credentials")


def post_to_slack(token: str, channel: str, blocks: list) -> bool:
    payload = json.dumps({
        "channel": channel,
        "blocks": blocks,
        "text": "Internship Pipeline Run Complete"
    }).encode()

    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
    )
    with urllib.request.urlopen(req) as r:
        resp = json.loads(r.read())
        return resp.get("ok", False)


def build_blocks(summary: dict, upsert_stats: dict) -> list:
    total = summary.get("total_programs", 0)
    elapsed = summary.get("elapsed_seconds", 0)
    sectors_run = summary.get("sectors_run", 0)
    inserted = upsert_stats.get("inserted", "?")
    updated = upsert_stats.get("updated", "?")
    total_active = upsert_stats.get("total_active", "?")

    # Sector results
    sector_lines = []
    for sr in summary.get("sector_results", []):
        status_emoji = "✅" if sr["status"] == "ok" else "⚠️" if sr["status"] == "timeout" else "❌"
        count = sr.get("count", 0)
        name = sr["sector"].replace("-", " ").title()
        sector_lines.append(f"{status_emoji} {name}: {count} programs")

    sector_text = "\n".join(sector_lines) if sector_lines else "No sectors run"

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🔍 Internship Pipeline Run Complete"}
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Programs found:*\n{total}"},
                {"type": "mrkdwn", "text": f"*Sectors searched:*\n{sectors_run}"},
                {"type": "mrkdwn", "text": f"*New programs:*\n{inserted}"},
                {"type": "mrkdwn", "text": f"*Updated:*\n{updated}"},
                {"type": "mrkdwn", "text": f"*Total in CDP:*\n{total_active}"},
                {"type": "mrkdwn", "text": f"*Time:*\n{elapsed:.0f}s"},
            ]
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Sector results:*\n```\n{sector_text}\n```"}
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": "Agent-native pipeline — Claude subagents searched the web for real program data."}
            ]
        }
    ]

    if upsert_stats.get("error"):
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"⚠️ *Upsert error:* {upsert_stats['error']}"}
        })

    return blocks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", default="{}", help="Orchestrator summary JSON string")
    parser.add_argument("--upsert-stats", default="{}", help="Upsert stats JSON string")
    parser.add_argument("--log-file", help="Path to log file")
    args = parser.parse_args()

    try:
        summary = json.loads(args.summary)
    except json.JSONDecodeError:
        summary = {}

    try:
        upsert_stats = json.loads(args.upsert_stats)
    except json.JSONDecodeError:
        upsert_stats = {}

    try:
        token = load_token()
    except Exception as e:
        print(f"Could not load Slack token: {e}", file=sys.stderr)
        sys.exit(1)

    blocks = build_blocks(summary, upsert_stats)

    if post_to_slack(token, SLACK_CHANNEL, blocks):
        print("Slack notification sent")
    else:
        print("Failed to send Slack notification", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
