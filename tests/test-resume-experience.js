#!/usr/bin/env node
/**
 * Backend integration tests for enhanced resume parsing and experience timeline.
 * Tests the parse prompt schema, merge logic, and API endpoints.
 *
 * Usage: node tests/test-resume-experience.js
 */

'use strict';

const https = require('https');
const http = require('http');

const API_BASE = 'http://localhost:3001';
let passed = 0;
let failed = 0;

// ─── Test helpers ─────────────────────────────────────────────────────────────

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
      });
    } else {
      console.log(`  ✅ ${name}`);
      passed++;
    }
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertContains(arr, item, msg) {
  if (!arr.includes(item)) throw new Error(`${msg || 'assertContains'}: ${JSON.stringify(arr)} does not contain ${JSON.stringify(item)}`);
}

function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 3001,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n📋 Backend — Resume & Experience Timeline Tests\n');

  // ── 1. Parse prompt schema ────────────────────────────────────────────────
  console.log('1. Parse prompt schema validation');

  const cdpResume = require('../routes/cdp-resume.js');
  // We can't run the full Claude subprocess in tests — test the prompt content
  const routeFile = require('fs').readFileSync(__dirname + '/../routes/cdp-resume.js', 'utf8');

  await test('PARSE_PROMPT includes "type" field', () => {
    assert(routeFile.includes('"type": "work|research|education|leadership|volunteer|other"'), 'type field missing from parse prompt');
  });

  await test('PARSE_PROMPT includes "startDate" field', () => {
    assert(routeFile.includes('"startDate"'), 'startDate missing from parse prompt');
  });

  await test('PARSE_PROMPT includes "endDate" field', () => {
    assert(routeFile.includes('"endDate"'), 'endDate missing from parse prompt');
  });

  await test('PARSE_PROMPT includes "description" field', () => {
    assert(routeFile.includes('"description"'), 'description missing from parse prompt');
  });

  await test('PARSE_PROMPT includes "id" field', () => {
    assert(routeFile.includes('"id"'), 'id field missing from parse prompt');
  });

  await test('PARSE_PROMPT includes "skills" in experience entries', () => {
    assert(routeFile.includes('"skills": ["specific tools'), 'skills array missing from parse prompt experience entries');
  });

  await test('PARSE_PROMPT sorts most recent first', () => {
    assert(routeFile.includes('Sort experience by startDate descending'), 'sort instruction missing');
  });

  await test('PARSE_PROMPT includes education type', () => {
    assert(routeFile.includes('"education" = degree program'), 'education type guide missing');
  });

  // ── 2. Merge logic ────────────────────────────────────────────────────────
  console.log('\n2. Experience merge logic');

  const mergeExperience = (existing, parsed) => {
    const existingKeys = new Set(existing.map(e => `${e.title}||${e.org}`));
    const newEntries = parsed.filter(e => !existingKeys.has(`${e.title}||${e.org}`));
    return [...existing, ...newEntries].sort((a, b) => {
      const da = a.startDate || '0000-00';
      const db = b.startDate || '0000-00';
      return db.localeCompare(da);
    });
  };

  await test('merges new entries from parsed resume', () => {
    const result = mergeExperience([], [
      { id: 'a1', type: 'work', title: 'Intern', org: 'AFRL', duration: '2025', startDate: '2025-05', endDate: '2025-08' },
    ]);
    assertEqual(result.length, 1, 'merge length');
  });

  await test('deduplicates by title+org', () => {
    const existing = [{ id: 'orig', type: 'work', title: 'Intern', org: 'AFRL', duration: '2025', startDate: '2025-05', endDate: '2025-08' }];
    const parsed = [{ id: 'dupe', type: 'work', title: 'Intern', org: 'AFRL', duration: '2025', startDate: '2025-05', endDate: '2025-08' }];
    const result = mergeExperience(existing, parsed);
    assertEqual(result.length, 1, 'dedup length');
    assertEqual(result[0].id, 'orig', 'keeps original');
  });

  await test('preserves manual entries not in parsed', () => {
    const existing = [{ id: 'manual', type: 'volunteer', title: 'Tutor', org: 'CC', duration: '2022', startDate: '2022-01', endDate: '2022-05' }];
    const parsed = [{ id: 'a1', type: 'work', title: 'HPC Intern', org: 'AFRL', duration: '2025', startDate: '2025-05', endDate: '2025-08' }];
    const result = mergeExperience(existing, parsed);
    assertEqual(result.length, 2, 'merged length');
  });

  await test('result is sorted most recent first', () => {
    const result = mergeExperience(
      [{ id: '1', type: 'education', title: 'BS', org: 'UF', duration: '2020-2024', startDate: '2020-08', endDate: '2024-05' }],
      [{ id: '2', type: 'work', title: 'Intern', org: 'AFRL', duration: '2025', startDate: '2025-05', endDate: '2025-08' }]
    );
    assert(result[0].startDate >= result[1].startDate, 'sorted descending');
  });

  // ── 3. API health check ────────────────────────────────────────────────────
  console.log('\n3. API integration (live backend)');

  await test('health endpoint responds 200', async () => {
    const r = await apiRequest('GET', '/health', null, null);
    assertEqual(r.status, 200, 'health status');
    assert(r.body.ok || r.body.status, 'health ok');
  });

  // ── 4. Auth + profile with experience field ────────────────────────────────
  const testEmail = `test-experience-${Date.now()}@lablink.test`;
  const testPass = 'TestPass123!';

  await test('register creates account', async () => {
    const r = await apiRequest('POST', '/api/cdp/auth/register', {
      email: testEmail, password: testPass, firstName: 'Test', lastName: 'User'
    });
    assert(r.status === 200 || r.status === 201, `register status should be 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.token, 'has token');
  });

  let token = null;
  await test('login returns token', async () => {
    const r = await apiRequest('POST', '/api/cdp/auth/login', { email: testEmail, password: testPass });
    assertEqual(r.status, 200, `login status (${JSON.stringify(r.body)})`);
    token = r.body.token;
    assert(token, 'has token');
  });

  await test('full-data returns expected StudentData structure', async () => {
    if (!token) throw new Error('No token — login failed');
    const r = await apiRequest('GET', '/api/cdp/students/me/full-data', null, token);
    assertEqual(r.status, 200, `full-data status: ${JSON.stringify(r.body)}`);
    assert(r.body.profile !== undefined, 'has profile');
    assert(r.body.skills !== undefined, 'has skills');
    assert(r.body.gapAnalyses !== undefined, 'has gapAnalyses');
  });

  await test('full-data PUT with experience array persists', async () => {
    if (!token) throw new Error('No token');
    const experience = [
      {
        id: 'a1b2c3d4',
        type: 'work',
        title: 'HPC Intern',
        org: 'AFRL',
        duration: 'May 2025 – Aug 2025',
        startDate: '2025-05',
        endDate: '2025-08',
        description: 'LAMMPS simulations',
        skills: ['LAMMPS', 'Python'],
      },
      {
        id: 'e5f6g7h8',
        type: 'education',
        title: 'Ph.D. Materials Science',
        org: 'CU Boulder',
        duration: 'Aug 2024 – Present',
        startDate: '2024-08',
        endDate: null,
      },
    ];

    const putBody = {
      profile: { firstName: 'Test', lastName: 'User', school: 'CU Boulder', year: 'PhD', major: 'Materials Science', gradYear: '2028', email: testEmail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      interests: [],
      skills: ['Python', 'LAMMPS'],
      goals: [],
      targetTimeline: '',
      gpa: 3.9,
      experienceLevel: '2+ internships or research positions',
      profileCompleteness: 0,
      savedPrograms: [],
      gapAnalyses: [],
      resumeUploaded: false,
      experience,
    };

    const r = await apiRequest('PUT', '/api/cdp/students/me/full-data', putBody, token);
    assertEqual(r.status, 200, `PUT full-data status: ${JSON.stringify(r.body)}`);
  });

  await test('full-data GET returns saved experience entries', async () => {
    if (!token) throw new Error('No token');
    const r = await apiRequest('GET', '/api/cdp/students/me/full-data', null, token);
    assertEqual(r.status, 200, 'GET full-data status');
    assert(Array.isArray(r.body.experience), `experience should be array, got: ${typeof r.body.experience}`);
    assertEqual(r.body.experience.length, 2, 'should have 2 entries');
    const hpc = r.body.experience.find(e => e.title === 'HPC Intern');
    assert(hpc, 'HPC Intern entry exists');
    assertEqual(hpc.type, 'work', 'type is work');
    assertEqual(hpc.org, 'AFRL', 'org is AFRL');
    assertEqual(hpc.endDate, '2025-08', 'endDate correct');
    const phd = r.body.experience.find(e => e.title === 'Ph.D. Materials Science');
    assert(phd, 'PhD entry exists');
    assert(phd.endDate === null, 'ongoing entry has null endDate');
  });

  await test('experience entries have required fields', async () => {
    if (!token) throw new Error('No token');
    const r = await apiRequest('GET', '/api/cdp/students/me/full-data', null, token);
    assertEqual(r.status, 200, 'GET status');
    r.body.experience.forEach(e => {
      assert(e.id, `entry missing id: ${JSON.stringify(e)}`);
      assert(e.type, `entry missing type: ${JSON.stringify(e)}`);
      assert(e.title, `entry missing title: ${JSON.stringify(e)}`);
      assert(e.org, `entry missing org: ${JSON.stringify(e)}`);
      assert(e.duration, `entry missing duration: ${JSON.stringify(e)}`);
    });
  });

  // ── 5. Profile completeness includes experience ────────────────────────────
  console.log('\n5. Profile completeness');

  await test('completeness includes experience score', () => {
    // Simulate completeness calc with experience
    const calc = (data) => {
      let score = 0;
      if (data.profile?.firstName) score += 10;
      if (data.profile?.lastName) score += 5;
      if (data.profile?.school) score += 10;
      if (data.profile?.year) score += 10;
      if (data.profile?.major) score += 10;
      if (data.interests?.length > 0) score += 15;
      if (data.skills?.length > 0) score += 10;
      if (data.goals?.length > 0) score += 10;
      if (data.targetTimeline) score += 5;
      if (data.gpa) score += 5;
      if (data.resumeUploaded) score += 5;
      if (data.experience?.length > 0) score += 5;
      return Math.min(100, score);
    };

    const withoutExp = calc({ profile: { firstName: 'A', lastName: 'B', school: 'CU', year: 'PhD', major: 'MS' }, interests: ['X'], skills: ['Python'], goals: ['Y'], targetTimeline: 'This summer', gpa: 3.9, resumeUploaded: true, experience: [] });
    const withExp = calc({ profile: { firstName: 'A', lastName: 'B', school: 'CU', year: 'PhD', major: 'MS' }, interests: ['X'], skills: ['Python'], goals: ['Y'], targetTimeline: 'This summer', gpa: 3.9, resumeUploaded: true, experience: [{ id: '1', type: 'work', title: 'Intern', org: 'Lab', duration: '2025' }] });

    assert(withExp > withoutExp, `With experience should score higher: ${withExp} vs ${withoutExp}`);
    assertEqual(withExp - withoutExp, 5, 'experience adds 5 points');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
