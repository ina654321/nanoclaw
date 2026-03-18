/**
 * Google Drive OAuth authorization script.
 * Reads OAuth client credentials from ~/.gmail-mcp/gcp-oauth.keys.json
 * Saves Drive tokens to ~/.gdrive-mcp/credentials.json
 *
 * Run: node scripts/gdrive-auth.mjs
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { google } from 'googleapis';

const OAUTH_KEYS = path.join(process.env.HOME, '.gmail-mcp', 'gcp-oauth.keys.json');
const GDRIVE_DIR = path.join(process.env.HOME, '.gdrive-mcp');
const CREDENTIALS_PATH = path.join(GDRIVE_DIR, 'credentials.json');
const OAUTH_KEYS_DST = path.join(GDRIVE_DIR, 'gcp-oauth.keys.json');
const REDIRECT_PORT = 3002;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

const SCOPES = ['https://www.googleapis.com/auth/drive'];

if (!fs.existsSync(OAUTH_KEYS)) {
  console.error(`OAuth keys not found at ${OAUTH_KEYS}`);
  process.exit(1);
}

fs.mkdirSync(GDRIVE_DIR, { recursive: true });
// Copy oauth keys into gdrive dir for use by the container MCP server
fs.copyFileSync(OAUTH_KEYS, OAUTH_KEYS_DST);

const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS, 'utf-8'));
const { client_id, client_secret } = keys.installed || keys.web;

const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\nPlease visit this URL to authorize Google Drive access:\n');
console.log(authUrl);
console.log('\nAfter authorization, your browser will redirect to localhost:3001 (which will fail).');
console.log('Copy the full redirect URL and paste it here.\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.includes('/oauth2callback')) return;
  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code found');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2));
    res.end('Authentication successful! You can close this window.');
    console.log(`\n✓ Drive credentials saved to ${CREDENTIALS_PATH}`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.end('Error: ' + err.message);
    console.error('Auth error:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Waiting for OAuth callback on port ${REDIRECT_PORT}...`);
});
