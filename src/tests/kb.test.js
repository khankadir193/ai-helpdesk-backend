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
  assert.ok(body.data.stats.publishedCount >= 1);
  assert.equal(body.data.categories.length, 4);
  assert.equal(body.data.recentlyUpdated.length, 4);
  assert.equal(body.data.popularArticles.length, 3);
});

test('GET /api/v1/kb/articles returns paginated items with consistent total and statusCounts', async () => {
  const res = await fetch(`${baseUrl}/kb/articles?page=1&pageSize=8`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.pageSize, 8);
  assert.equal(body.data.items.length, 8);
  const counts = body.data.statusCounts;
  assert.equal(
    counts.all,
    counts.published + counts.draft + counts.in_review + counts.archived
  );
  assert.equal(body.data.total, counts.all);
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

test('GET /api/v1/kb/categories returns categories with article counts', async () => {
  const res = await fetch(`${baseUrl}/kb/categories`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.ok(body.data.categories.length >= 4);
  assert.equal(typeof body.data.uncategorizedCount, 'number');

  const billing = body.data.categories.find((c) => c.name === 'Billing & subscriptions');
  assert.ok(billing);
  assert.ok(billing.total_count >= 18);
  assert.ok(billing.published_count >= 15);
});

test('GET /api/v1/kb/articles filters accurately by all 4 category slugs and matches overview card counts', async () => {
  const ovRes = await fetch(`${baseUrl}/kb/overview`, { headers: { Cookie: cookie } });
  const ovBody = await ovRes.json();

  for (const cat of ovBody.data.categories) {
    // Reproduces the exact failing URL pattern: q=&status=ALL&categoryId=<slug>&sort=article_id&order=asc&page=1&pageSize=8
    const res = await fetch(
      `${baseUrl}/kb/articles?q=&status=ALL&categoryId=${encodeURIComponent(cat.slug)}&sort=article_id&order=asc&page=1&pageSize=8`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(res.status, 200, `Expected 200 for category slug ${cat.slug}`);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.data.total, cat.total_count, `Total mismatch for ${cat.slug}`);
    assert.equal(body.data.statusCounts.all, cat.total_count);
    assert.equal(body.data.statusCounts.published, cat.published_count);
    for (const item of body.data.items) {
      assert.equal(item.category_slug, cat.slug);
    }

    // Also verify numeric category id works identically
    const idRes = await fetch(
      `${baseUrl}/kb/articles?categoryId=${cat.id}&page=1&pageSize=8`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(idRes.status, 200);
    const idBody = await idRes.json();
    assert.equal(idBody.data.total, cat.total_count);
  }
});

test('GET /api/v1/kb/articles supports category + status, search, sort asc/desc, page 2, uncategorized, and unknown category', async () => {
  const ovRes = await fetch(`${baseUrl}/kb/overview`, { headers: { Cookie: cookie } });
  const ovBody = await ovRes.json();
  const accountSec = ovBody.data.categories.find((c) => c.slug === 'account-security');
  assert.ok(accountSec);

  // 1. Category + status (case-insensitive)
  const pubRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=account-security&status=published&sort=article_id&order=asc&page=1&pageSize=8`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(pubRes.status, 200);
  const pubBody = await pubRes.json();
  assert.equal(pubBody.data.total, accountSec.published_count);
  assert.equal(pubBody.data.statusCounts.all, accountSec.total_count);
  assert.equal(pubBody.data.statusCounts.published, accountSec.published_count);
  assert.ok(pubBody.data.items.every((i) => i.status === 'PUBLISHED'));

  // 2. Category + search
  const searchRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=account-security&q=2FA`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json();
  assert.ok(searchBody.data.total >= 1);
  assert.ok(searchBody.data.items.some((i) => i.article_id === 'KB-104'));

  // 3. Category + sort desc vs asc
  const ascRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=account-security&sort=article_id&order=asc&page=1&pageSize=8`,
    { headers: { Cookie: cookie } }
  );
  const descRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=account-security&sort=article_id&order=desc&page=1&pageSize=8`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(ascRes.status, 200);
  assert.equal(descRes.status, 200);
  const ascBody = await ascRes.json();
  const descBody = await descRes.json();
  assert.notEqual(ascBody.data.items[0].article_id, descBody.data.items[0].article_id);

  // 4. Category + page 2
  const page2Res = await fetch(
    `${baseUrl}/kb/articles?categoryId=account-security&sort=article_id&order=asc&page=2&pageSize=8`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(page2Res.status, 200);
  const page2Body = await page2Res.json();
  assert.equal(page2Body.data.page, 2);
  assert.ok(page2Body.data.items.length >= 1);

  // 5. Uncategorized
  const uncatRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=uncategorized`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(uncatRes.status, 200);
  const uncatBody = await uncatRes.json();
  assert.equal(typeof uncatBody.data.total, 'number');

  // 6. Unknown category slug -> 200 empty list (never 500)
  const unknownRes = await fetch(
    `${baseUrl}/kb/articles?categoryId=does-not-exist`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(unknownRes.status, 200);
  const unknownBody = await unknownRes.json();
  assert.equal(unknownBody.data.total, 0);
  assert.deepEqual(unknownBody.data.items, []);

  // 7. Invalid status enum -> 400 (never 500)
  const badStatusRes = await fetch(
    `${baseUrl}/kb/articles?status=INVALID_ENUM`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(badStatusRes.status, 400);

  // 8. Invalid authorId -> 400 (never 500)
  const badAuthorRes = await fetch(
    `${baseUrl}/kb/articles?authorId=abc`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(badAuthorRes.status, 400);
});
