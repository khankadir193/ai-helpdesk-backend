import app from '../src/app.js';

let server;

async function testApi() {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  console.log(`Testing KB API on port ${port}...`);

  // 1. Login as admin
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'khanAdmin@543' }),
  });
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
  console.log('Login status:', loginRes.status, 'Cookie:', cookie ? 'Received' : 'None');

  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookie,
  };

  // 2. Overview
  const ovRes = await fetch(`${baseUrl}/kb/overview`, { headers });
  const ovData = await ovRes.json();
  console.log('Overview stats:', ovData.data?.stats);
  console.log('Overview categories count:', ovData.data?.categories?.length);
  console.log('Overview recently updated count:', ovData.data?.recentlyUpdated?.length);
  console.log('Overview popular count:', ovData.data?.popularArticles?.length);

  // 3. Articles list
  const artRes = await fetch(`${baseUrl}/kb/articles?page=1&pageSize=8`, { headers });
  const artData = await artRes.json();
  console.log('Articles total:', artData.data?.total, 'statusCounts:', artData.data?.statusCounts);
  console.log('Articles page items count:', artData.data?.items?.length);

  // 4. Single article
  const singleRes = await fetch(`${baseUrl}/kb/articles/KB-101`, { headers });
  const singleData = await singleRes.json();
  console.log('KB-101 title:', singleData.data?.title, 'category:', singleData.data?.category_name);

  // 5. Categories
  const catRes = await fetch(`${baseUrl}/kb/categories`, { headers });
  const catData = await catRes.json();
  console.log('Categories count:', catData.data?.categories?.length, 'Uncategorized:', catData.data?.uncategorizedCount);

  // 6. Authors
  const authRes = await fetch(`${baseUrl}/kb/authors`, { headers });
  const authData = await authRes.json();
  console.log('Authors count:', authData.data?.length);

  server.close();
  process.exit(0);
}

testApi().catch((err) => {
  console.error('Test failed:', err);
  if (server) server.close();
  process.exit(1);
});

