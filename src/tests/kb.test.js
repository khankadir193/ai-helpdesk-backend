import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import app from '../app.js';

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // Login as admin
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'khanAdmin@543' }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  cookie = setCookie.split(';')[0];
});

after(() => {
  if (server) server.close();
});

test('GET /api/v1/kb/overview returns stats, categories, recently updated, and popular articles', async () => {
  const res = await fetch(`${baseUrl}/kb/overview`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.ok(body.data.stats);
  assert.equal(body.data.stats.publishedCount, 48);
  assert.equal(body.data.stats.draftCount, 6);
  assert.equal(body.data.stats.reviewCount, 2);
  assert.equal(body.data.stats.archivedCount, 4);
  assert.equal(body.data.categories.length, 4);
  assert.equal(body.data.recentlyUpdated.length, 4);
  assert.equal(body.data.popularArticles.length, 3);
});

test('GET /api/v1/kb/articles returns 60 total and 8 per page with status counts', async () => {
  const res = await fetch(`${baseUrl}/kb/articles?page=1&pageSize=8`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.total, 60);
  assert.equal(body.data.pageSize, 8);
  assert.equal(body.data.items.length, 8);
  assert.deepEqual(body.data.statusCounts, {
    all: 60,
    published: 48,
    draft: 6,
    in_review: 2,
    archived: 4,
  });
});

test('GET /api/v1/kb/articles/KB-101 retrieves Duplicate subscription charges', async () => {
  const res = await fetch(`${baseUrl}/kb/articles/KB-101`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.article_id, 'KB-101');
  assert.equal(body.data.title, 'Duplicate subscription charges');
  assert.equal(body.data.category_name, 'Billing & subscriptions');
});

test('GET /api/v1/kb/categories returns 4 categories with exact article counts', async () => {
  const res = await fetch(`${baseUrl}/kb/categories`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.categories.length, 4);
  assert.equal(body.data.uncategorizedCount, 0);

  const billing = body.data.categories.find((c) => c.name === 'Billing & subscriptions');
  assert.ok(billing);
  assert.equal(billing.total_count, 18);
  assert.equal(billing.published_count, 15);
});

