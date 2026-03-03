'use strict';

const express = require('express');
const https = require('https');
const querystring = require('querystring');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const router = express.Router();
const JWT_SECRET = process.env.CDP_JWT_SECRET || 'dev-secret-change-in-prod';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://app.lablinkinitiative.org/api/cdp/auth/google/callback';
const FRONTEND_URL = 'https://cdp.lablinkinitiative.org';

// ── GET /auth/google — initiate OAuth flow ───────────────────────────────────

router.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured on server' });
  }
  const params = querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── GET /auth/google/callback — exchange code, issue JWT ─────────────────────

router.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}/signin?error=oauth_cancelled`);
  }

  try {
    const tokens = await exchangeCodeForTokens(String(code));
    const googleUser = await getGoogleUserInfo(tokens.access_token);

    // Find by google_id first, then by email (link existing account)
    let student = db.prepare('SELECT * FROM cdp_students WHERE google_id = ?').get(googleUser.sub);

    if (!student) {
      student = db.prepare('SELECT * FROM cdp_students WHERE email = ?').get(googleUser.email);
      if (student) {
        // Link Google account to existing email account
        db.prepare('UPDATE cdp_students SET google_id = ? WHERE id = ?').run(googleUser.sub, student.id);
        student = db.prepare('SELECT * FROM cdp_students WHERE id = ?').get(student.id);
      } else {
        // Create new student account
        const uid = uuidv4();
        const nameParts = (googleUser.name || '').split(' ');
        const firstName = googleUser.given_name || nameParts[0] || '';
        const lastName = googleUser.family_name || nameParts.slice(1).join(' ') || '';
        db.prepare(`
          INSERT INTO cdp_students (uid, email, password_hash, first_name, last_name, google_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uid, googleUser.email, '', firstName, lastName, googleUser.sub);
        student = db.prepare('SELECT * FROM cdp_students WHERE uid = ?').get(uid);
      }
    }

    const token = jwt.sign({ uid: student.uid, email: student.email }, JWT_SECRET, { expiresIn: '30d' });
    const isNew = !student.school && !student.major;
    const dest = isNew ? '/onboarding' : '/dashboard';

    res.redirect(
      `${FRONTEND_URL}/oauth-callback` +
      `?token=${encodeURIComponent(token)}` +
      `&dest=${encodeURIComponent(dest)}` +
      `&firstName=${encodeURIComponent(student.first_name || '')}`
    );
  } catch (err) {
    console.error('[google-oauth] callback error:', err.message);
    res.redirect(`${FRONTEND_URL}/signin?error=oauth_failed`);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
          else resolve(parsed);
        } catch { reject(new Error('Failed to parse token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getGoogleUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: '/oauth2/v3/userinfo',
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse user info')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = router;
