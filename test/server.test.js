import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

// The server reads DATA_DIR when it loads, so point it at a scratch directory
// before importing it.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), '2048-test-'));
process.env.DATA_DIR = DATA_DIR;

const { createServer } = await import('../server.js');

after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(DATA_DIR, 'leaderboard.json'), { force: true });
});

/** Start the server on a free port, run `fn`, then shut it down. */
async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body) =>
  fetch(`${base}/api/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const run = (overrides = {}) => ({ name: 'Ada', score: 1200, bestTile: 128, moves: 90, ...overrides });

/** Send a request line verbatim, bypassing fetch's path normalization. */
function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('an empty board returns an empty list', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/scores`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { scores: [] });
  });
});

test('a posted run comes back ranked', async () => {
  await withServer(async (base) => {
    const response = await post(base, run());
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.rank, 1);
    assert.equal(body.entry.name, 'Ada');
    assert.equal(body.entry.score, 1200);
    assert.ok(body.entry.id, 'the server assigns an id');
    assert.ok(Date.parse(body.entry.createdAt), 'the server timestamps the entry');
    assert.deepEqual(body.scores.map((row) => row.score), [1200]);

    const listed = await (await fetch(`${base}/api/scores`)).json();
    assert.deepEqual(listed.scores.map((row) => row.score), [1200]);
  });
});

test('scores are ordered best first', async () => {
  await withServer(async (base) => {
    for (const score of [500, 2500, 1500]) {
      await post(base, run({ score }));
    }
    const { scores } = await (await fetch(`${base}/api/scores`)).json();
    assert.deepEqual(scores.map((row) => row.score), [2500, 1500, 500]);
  });
});

test('the client cannot dictate its own id or timestamp', async () => {
  await withServer(async (base) => {
    const body = await (
      await post(base, { ...run(), id: 'spoofed', createdAt: '1999-01-01T00:00:00Z' })
    ).json();

    assert.notEqual(body.entry.id, 'spoofed');
    assert.notEqual(body.entry.createdAt, '1999-01-01T00:00:00.000Z');
  });
});

test('the list honours a limit', async () => {
  await withServer(async (base) => {
    for (const score of [100, 200, 300]) {
      await post(base, run({ score }));
    }
    const { scores } = await (await fetch(`${base}/api/scores?limit=2`)).json();
    assert.deepEqual(scores.map((row) => row.score), [300, 200]);
  });
});

test('an invalid limit falls back to the default', async () => {
  await withServer(async (base) => {
    await post(base, run());
    for (const limit of ['abc', '-1', '0', '']) {
      const response = await fetch(`${base}/api/scores?limit=${limit}`);
      assert.equal(response.status, 200, `limit=${limit} should not fail`);
      assert.equal((await response.json()).scores.length, 1);
    }
  });
});

test('invalid runs are rejected with a reason', async () => {
  await withServer(async (base) => {
    const response = await post(base, { score: -5 });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /score/);

    const { scores } = await (await fetch(`${base}/api/scores`)).json();
    assert.deepEqual(scores, [], 'a rejected run must not be stored');
  });
});

test('malformed JSON is rejected', async () => {
  await withServer(async (base) => {
    const response = await post(base, '{not json');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON/);
  });
});

test('an oversized body is refused', async () => {
  await withServer(async (base) => {
    const response = await post(base, { ...run(), name: 'x'.repeat(64 * 1024) });
    assert.equal(response.status, 413);
  });
});

test('unsupported methods and endpoints are reported', async () => {
  await withServer(async (base) => {
    const put = await fetch(`${base}/api/scores`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');

    const unknown = await fetch(`${base}/api/nope`);
    assert.equal(unknown.status, 404);

    const postStatic = await fetch(`${base}/index.html`, { method: 'POST' });
    assert.equal(postStatic.status, 405);
  });
});

test('the game page is served at the root', async () => {
  await withServer(async (base) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);

    const html = await response.text();
    assert.match(html, /<title>2048<\/title>/);
    assert.match(html, /src="src\/main\.js"/);
  });
});

test('modules and styles are served with the right content types', async () => {
  await withServer(async (base) => {
    const script = await fetch(`${base}/src/game.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const styles = await fetch(`${base}/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type'), /text\/css/);
  });
});

test('missing files and directories give a 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${base}/src/`)).status, 404);
  });
});

test('paths cannot escape the project directory', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    for (const target of ['/../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd']) {
      const response = await rawRequest(port, `GET ${target} HTTP/1.1`);
      const status = Number(response.split(' ')[1]);
      assert.ok(status === 403 || status === 404, `${target} returned ${status}`);
      assert.doesNotMatch(response, /root:/, `${target} leaked a system file`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hidden files are not served', async () => {
  await withServer(async (base) => {
    for (const target of ['/.git/config', '/.gitignore', '/.github/workflows/ci.yml']) {
      const response = await fetch(`${base}${target}`);
      assert.equal(response.status, 404, `${target} should not be served`);
    }
  });
});

test('scores survive a restart', async () => {
  await withServer(async (base) => {
    await post(base, run({ score: 4242 }));
  });

  await withServer(async (base) => {
    const { scores } = await (await fetch(`${base}/api/scores`)).json();
    assert.deepEqual(scores.map((row) => row.score), [4242]);
  });
});

test('a corrupt data file does not take the server down', async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'leaderboard.json'), 'garbage{');

  await withServer(async (base) => {
    const list = await fetch(`${base}/api/scores`);
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).scores, []);

    const saved = await post(base, run());
    assert.equal(saved.status, 201);
  });
});

test('concurrent submissions are all kept', async () => {
  await withServer(async (base) => {
    const scores = Array.from({ length: 12 }, (_, i) => (i + 1) * 100);
    await Promise.all(scores.map((score) => post(base, run({ score }))));

    const { scores: top } = await (await fetch(`${base}/api/scores?limit=50`)).json();
    assert.equal(top.length, scores.length, 'a concurrent write was lost');
    assert.deepEqual(
      top.map((row) => row.score),
      [...scores].sort((a, b) => b - a),
    );
  });
});
