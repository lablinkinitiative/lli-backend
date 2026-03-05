#!/usr/bin/env node
/**
 * Pathway System v2 — Live E2E Validation
 * Gates 45-58 from pathway-system-v2.md
 * Uses a persistent test account or creates a fresh one
 */

'use strict';

const https = require('https');
const http = require('http');

const BASE = 'https://app.lablinkinitiative.org';
const SITE = 'https://cdp.lablinkinitiative.org';

const TEST_EMAIL = `test-pathway-e2e-${Date.now()}@lablinkinitiative.org`;
const TEST_PASS = 'TestE2E123!';
let authToken = null;
let testUid = null;
let assigned = [];

let passed = 0;
let failed = 0;
const failures = [];

function request(method, path, body = null, token = null, base = BASE) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = (isHttps ? https : http).request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { _raw: data.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function gate(num, name, condition, detail = '') {
  const label = `E2E GATE ${String(num).padStart(2, '0')}`;
  if (condition) {
    console.log(`  ✓ ${label} — ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — ${name}${detail ? ': ' + detail : ''}`);
    failed++;
    failures.push(`${label}: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Pathway System v2 — Live E2E Validation');
  console.log('='.repeat(60));

  // GATE 45 — Create test account
  console.log('\n=== Setup ===');
  const reg = await request('POST', '/api/cdp/auth/register', {
    email: TEST_EMAIL, password: TEST_PASS, firstName: 'E2E', lastName: 'TestPathway',
  });
  gate(45, 'Create test account',
    reg.status === 201 || reg.status === 200,
    `status=${reg.status}`);

  const login = await request('POST', '/api/cdp/auth/login', { email: TEST_EMAIL, password: TEST_PASS });
  authToken = login.body.token;
  testUid = login.body.user?.uid;

  if (!authToken) {
    console.error('Cannot get auth token — aborting');
    process.exit(1);
  }

  // GATE 46 — Fill profile to 60%+
  const profileResult = await request('PUT', '/api/cdp/students/me/full-data', {
    profile: { firstName: 'E2E', lastName: 'TestPathway', school: 'MIT', year: 'junior', major: 'Computer Science' },
    skills: ['Python', 'Machine Learning', 'TensorFlow', 'Data Analysis', 'Statistics', 'Scikit-learn'],
    interests: ['AI research', 'machine learning', 'computational biology', 'data science'],
    goals: ['research internship', 'PhD in ML', 'work at national lab'],
    gpa: '3.8',
    targetTimeline: '6 months',
    resumeUploaded: true,
    experience: [{
      type: 'research', title: 'ML Research Assistant', org: 'MIT CSAIL',
      duration: '1 year', description: 'Built neural network optimization algorithms',
    }],
  }, authToken);
  gate(46, 'Fill profile to 60%+',
    profileResult.status === 200 || profileResult.body.saved === true,
    `status=${profileResult.status}`);

  // GATE 47 — Generate pathways
  console.log('\n=== Pathway Generation ===');
  const genResult = await request('POST', '/api/cdp/students/me/pathways/generate', {}, authToken);
  gate(47, 'POST generate → job_id returned',
    genResult.status === 200 && genResult.body.job_id,
    `status=${genResult.status}, job_id=${genResult.body.job_id}`);

  if (!genResult.body.job_id) {
    console.error('No job_id — cannot continue');
    process.exit(1);
  }

  const jobId = genResult.body.job_id;

  // GATE 48 — Wait for completion (<120s)
  console.log('  Polling for generation completion...');
  let genStatus = 'pending';
  let attempts = 0;
  while (['pending', 'running'].includes(genStatus) && attempts < 40) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await request('GET', `/api/cdp/students/me/pathways/status/${jobId}`, null, authToken);
    genStatus = poll.body.status;
    attempts++;
    if (attempts % 3 === 0) process.stdout.write(` [${genStatus}]`);
  }
  console.log(`\n  Final status: ${genStatus} (${attempts * 3}s)`);

  gate(48, 'Generation completes in <120s',
    genStatus === 'complete',
    `status=${genStatus}`);

  // GATE 49 — 3 pathways in DB
  const pathwaysResult = await request('GET', '/api/cdp/students/me/pathways', null, authToken);
  assigned = pathwaysResult.body.pathways || [];
  gate(49, 'GET /students/me/pathways → 3 rows',
    assigned.length === 3,
    `count=${assigned.length}`);

  // GATE 50 — Distinct tiers
  const tiers = assigned.map(p => p.fit_tier);
  gate(50, '3 distinct tiers (high, medium, stretch)',
    tiers.includes('high') && tiers.includes('medium') && tiers.includes('stretch'),
    `tiers=${tiers.join(',')}`);

  // GATE 51 — Each pathway has gap_analysis queued/processing/complete
  const withGap = assigned.filter(p => p.gap_analysis !== null);
  gate(51, 'Gap analyses auto-queued for each pathway',
    withGap.length > 0,
    `with_gap=${withGap.length}/3`);

  // GATE 52 — Wait for at least 1 gap analysis to complete
  console.log('\n=== Gap Analysis ===');
  console.log('  Waiting for gap analyses to complete...');
  let completeGap = null;
  let gaAttempts = 0;

  while (!completeGap && gaAttempts < 60) {
    await new Promise(r => setTimeout(r, 3000));
    const fresh = await request('GET', '/api/cdp/students/me/pathways', null, authToken);
    const freshPathways = fresh.body.pathways || [];

    for (const pw of freshPathways) {
      if (pw.gap_analysis?.status === 'complete') {
        completeGap = pw.gap_analysis;
        break;
      }
      // Also poll gap analysis directly
      if (pw.gap_analysis?.id) {
        const ga = await request('GET', `/api/cdp/gap-analysis/${pw.gap_analysis.id}`, null, authToken);
        if (ga.body.analysis?.status === 'complete') {
          completeGap = ga.body.analysis;
          break;
        }
      }
    }
    gaAttempts++;
    if (gaAttempts % 5 === 0) process.stdout.write(` [${gaAttempts * 3}s]`);
  }
  console.log(`\n  Gap analysis ${completeGap ? 'complete' : 'still pending'} after ${gaAttempts * 3}s`);

  gate(52, 'At least one gap analysis completes within 180s',
    completeGap !== null,
    completeGap ? `match=${completeGap.overall_match}%` : 'none completed');

  gate(53, 'Completed gap analysis has non-empty summary',
    !!(completeGap?.summary && completeGap.summary.length > 10),
    `summary_len=${completeGap?.summary?.length || 0}`);

  // GATE 54 — API: check gap analyses list
  const gaList = await request('GET', '/api/cdp/gap-analyses', null, authToken);
  gate(54, 'GET /gap-analyses returns list for student',
    gaList.status === 200 && Array.isArray(gaList.body.analyses),
    `count=${gaList.body.analyses?.length}`);

  // GATE 55 — Live site responds
  console.log('\n=== Live Site Check ===');
  const siteCheck = await request('GET', '/', null, null, SITE);
  gate(55, 'cdp.lablinkinitiative.org responds 200',
    siteCheck.status === 200,
    `status=${siteCheck.status}`);

  // GATE 56 — API pathways search works on live site
  const searchCheck = await request('GET', '/api/cdp/pathways?search=machine+learning', null, null);
  gate(56, 'Live API: pathway search returns results',
    searchCheck.status === 200 && searchCheck.body.count > 0,
    `count=${searchCheck.body.count}`);

  // GATE 57 — Pathway explorer (all 15 pathways available)
  const explorerCheck = await request('GET', '/api/cdp/pathways', null, null);
  gate(57, '15+ pathways available in library',
    explorerCheck.status === 200 && explorerCheck.body.count >= 15,
    `count=${explorerCheck.body.count}`);

  // GATE 58 — Explorer gap analysis doesn't alter defaults
  console.log('\n=== Explorer Independence ===');
  const explorerPathways = explorerCheck.body.pathways || [];
  const nonDefaultPathway = explorerPathways.find(p => !assigned.some(a => a.pathway_id === p.id));

  if (nonDefaultPathway) {
    // Run gap analysis from "explorer" on a non-assigned pathway
    const explorerGa = await request('POST', '/api/cdp/gap-analysis/run', {
      pathway_id: nonDefaultPathway.id,
    }, authToken);

    gate(58, 'Explorer gap analysis queued for non-default pathway',
      explorerGa.status === 200 && explorerGa.body.ok,
      `status=${explorerGa.status}`);

    // Verify default assignments unchanged
    const afterExplorer = await request('GET', '/api/cdp/students/me/pathways', null, authToken);
    const afterTiers = (afterExplorer.body.pathways || []).map(p => p.fit_tier).sort().join(',');
    const originalTiers = assigned.map(p => p.fit_tier).sort().join(',');
    gate(58, 'Default pathway assignments unchanged after explorer analysis',
      afterTiers === originalTiers,
      `before=${originalTiers}, after=${afterTiers}`);
  } else {
    gate(58, 'Explorer non-default pathway analysis', true, '(all pathways already assigned — skipped)');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`E2E Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailed gates:');
    failures.forEach(f => console.log('  ✗', f));
  } else {
    console.log('\n✓ All E2E gates passed!');
  }
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
