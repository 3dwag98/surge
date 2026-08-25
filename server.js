/**
 * Static file server for the game plus a small JSON API for the shared
 * leaderboard. Deliberately dependency-free: `npm start` and nothing to install.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEADERBOARD_LIMIT,
  ValidationError,
  insertEntry,
  normalizeEntry,
  rankEntries,
} from './src/scores.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');

/** Refuse oversized request bodies rather than buffering them. */
const MAX_BODY_BYTES = 8 * 1024;
/** Keep some history beyond the visible top ten. */
const MAX_STORED_ENTRIES = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serialises writes so concurrent submissions cannot clobber each other. */
let writeChain = Promise.resolve();

async function readScores() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.scores) ? parsed.scores : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    // A corrupt file should not take the server down; start a fresh board.
    console.warn(`[leaderboard] ignoring unreadable ${DATA_FILE}: ${error.message}`);
    return [];
  }
}

async function writeScores(scores) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ scores }, null, 2));
  await fs.rename(tmp, DATA_FILE); // atomic swap, so readers never see a partial file
}

/** Run `task` with exclusive access to the score file. */
function withScoreLock(task) {
  const result = writeChain.then(task, task);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining, but stop buffering
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        // Reject now but let the stream finish, so the 413 still reaches the
        // client instead of being lost to a destroyed socket.
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleGetScores(req, res, url) {
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_STORED_ENTRIES) : LEADERBOARD_LIMIT;
  const scores = await readScores();
  sendJSON(res, 200, { scores: rankEntries(scores, limit) });
}

async function handlePostScore(req, res) {
  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    sendJSON(res, 400, { error: 'body must be valid JSON' });
    return;
  }

  let entry;
  try {
    entry = normalizeEntry(parsed);
  } catch (error) {
    if (error instanceof ValidationError) {
      sendJSON(res, 400, { error: error.message });
      return;
    }
    throw error;
  }

  const outcome = await withScoreLock(async () => {
    const stored = await readScores();
    const { rank } = insertEntry(stored, entry, LEADERBOARD_LIMIT);
    const retained = rankEntries([...stored, entry], MAX_STORED_ENTRIES);
    await writeScores(retained);
    return { rank, scores: rankEntries(retained, LEADERBOARD_LIMIT) };
  });

  sendJSON(res, 201, { entry, rank: outcome.rank, scores: outcome.scores });
}

async function serveStatic(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(ROOT, `.${decoded}`);

  // Never serve anything outside the project directory.
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    sendJSON(res, 403, { error: 'forbidden' });
    return;
  }

  // Hidden files are never part of the game — most importantly .git, since the
  // server usually runs from a checkout.
  if (decoded.split('/').some((segment) => segment.startsWith('.') && segment !== '.')) {
    sendJSON(res, 404, { error: 'not found' });
    return;
  }

  try {
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) {
      sendJSON(res, 404, { error: 'not found' });
      return;
    }
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendJSON(res, 404, { error: 'not found' });
      return;
    }
    throw error;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/api/scores') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          await handleGetScores(req, res, url);
        } else if (req.method === 'POST') {
          await handlePostScore(req, res);
        } else {
          res.setHeader('allow', 'GET, POST');
          sendJSON(res, 405, { error: 'method not allowed' });
        }
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJSON(res, 404, { error: 'unknown endpoint' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        sendJSON(res, 405, { error: 'method not allowed' });
        return;
      }

      await serveStatic(req, res, url);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[server]', error);
      if (!res.headersSent) sendJSON(res, status, { error: error.message ?? 'internal error' });
      else res.end();
    }
  });
}

// Only listen when executed directly, so tests can import `createServer`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`2048 running at http://${host}:${port}`);
  });
}
