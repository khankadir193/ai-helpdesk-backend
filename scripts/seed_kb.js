import bcrypt from 'bcrypt';
import database from '../src/config/database.js';

async function seed() {
  console.log('Seeding Knowledge Base data...');

  // 1. Seed/ensure users (Maya Chen, Priya Nair, Liam Park, Jonas Weber)
  const defaultPasswordHash = await bcrypt.hash('khanAdmin@543', 10);
  const usersToSeed = [
    {
      name: 'Maya Chen',
      email: 'maya@helpdesk.ai',
      role: 'ADMIN',
    },
    {
      name: 'Priya Nair',
      email: 'priya@helpdesk.ai',
      role: 'AGENT',
    },
    {
      name: 'Liam Park',
      email: 'liam@helpdesk.ai',
      role: 'AGENT',
    },
    {
      name: 'Jonas Weber',
      email: 'jonas@helpdesk.ai',
      role: 'AGENT',
    },
  ];

  const userMap = {};
  for (const u of usersToSeed) {
    const existing = await database.query(
      'SELECT id, name, email, role FROM users WHERE lower(email) = lower($1)',
      [u.email]
    );
    if (existing.rows.length > 0) {
      userMap[u.name] = existing.rows[0].id;
      await database.query(
        'UPDATE users SET name = $1, role = $2 WHERE id = $3',
        [u.name, u.role, existing.rows[0].id]
      );
    } else {
      const ins = await database.query(
        'INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id',
        [u.name, u.email, defaultPasswordHash, u.role]
      );
      userMap[u.name] = ins.rows[0].id;
    }
  }
  console.log('Users ready:', userMap);

  // 2. Seed Categories
  const categoriesToSeed = [
    {
      name: 'Billing & subscriptions',
      slug: 'billing-subscriptions',
      description: 'Payments, invoices and refunds',
      icon: 'credit-card',
      display_order: 1,
      owner_name: 'Priya Nair',
    },
    {
      name: 'Account & security',
      slug: 'account-security',
      description: 'Sign-in, passwords and access',
      icon: 'user',
      display_order: 2,
      owner_name: 'Maya Chen',
    },
    {
      name: 'Getting started',
      slug: 'getting-started',
      description: 'Workspace setup and first steps',
      icon: 'rocket',
      display_order: 3,
      owner_name: 'Jonas Weber',
    },
    {
      name: 'Integrations & API',
      slug: 'integrations-api',
      description: 'Connected apps and API guides',
      icon: 'plug',
      display_order: 4,
      owner_name: 'Liam Park',
    },
  ];

  const categoryMap = {};
  for (const c of categoriesToSeed) {
    const ownerId = userMap[c.owner_name];
    const existing = await database.query(
      'SELECT id FROM kb_categories WHERE lower(name) = lower($1)',
      [c.name]
    );
    if (existing.rows.length > 0) {
      categoryMap[c.name] = existing.rows[0].id;
      await database.query(
        `UPDATE kb_categories SET
          slug = $1,
          description = $2,
          icon = $3,
          display_order = $4,
          owner_id = $5,
          is_active = true,
          updated_at = now()
         WHERE id = $6`,
        [c.slug, c.description, c.icon, c.display_order, ownerId, existing.rows[0].id]
      );
    } else {
      const ins = await database.query(
        `INSERT INTO kb_categories
          (name, slug, description, icon, display_order, owner_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING id`,
        [c.name, c.slug, c.description, c.icon, c.display_order, ownerId]
      );
      categoryMap[c.name] = ins.rows[0].id;
    }
  }
  console.log('Categories ready:', categoryMap);

  // 3. Clear existing KB articles to ensure clean, non-duplicated exact 60 articles seed
  await database.query('TRUNCATE TABLE kb_article_feedback, kb_article_versions, kb_articles RESTART IDENTITY CASCADE');

  // Exact articles from reference designs:
  const articlesList = [
    {
      article_id: 'KB-101',
      title: 'Duplicate subscription charges',
      slug: 'duplicate-subscription-charges',
      summary: 'How to identify a duplicate payment and request a refund.',
      category_name: 'Billing & subscriptions',
      author_name: 'Maya Chen',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      tags: ['duplicate-charge', 'subscription'],
      published_version: 3,
      draft_version: 4,
      draft_title: 'Duplicate subscription charges',
      draft_summary: 'Identify a duplicate payment and request a billing review.',
      draft_content: `<p>Seeing two Pro subscription charges? Verify both payments before requesting a refund. A pending authorization is not a completed payment.</p>
<h2>Check your billing history</h2>
<p>1. Go to Settings &rarr; Billing &rarr; Payment history.<br/>2. Compare invoice numbers, amounts and billing periods.<br/>3. If both payments are completed, collect both transaction IDs.</p>
<h2>Request a billing review</h2>
<p>Contact support with your workspace email, transaction IDs and charge dates. We verify duplicates before confirming a refund. Approved refunds typically appear within 5–10 business days. Never share your full card number or security code.</p>`,
      has_draft_revision: true,
      draft_saved_at: '2026-10-29T10:42:00Z',
      published_at: '2026-10-15T09:00:00Z',
      updated_at: '2026-10-29T10:42:00Z',
      view_count: 1824,
      helpful_yes: 171,
      helpful_no: 11,
      content: `<p>Seeing two charges for the same Pro subscription? Follow these steps to check whether both payments settled before contacting our billing team.</p>
<h2>1. Check your billing history</h2>
<p>Go to Settings &rarr; Billing &rarr; Payment history. Compare the amount, date and invoice number for each charge. Make sure both charges belong to the same workspace and billing period.</p>
<h2>2. Distinguish pending from completed payments</h2>
<p>A pending authorization is not a completed payment. Your bank usually releases it within 3–5 business days. If both payments show as completed, gather the two invoice or transaction IDs.</p>
<div class="kb-info-callout">
  <div class="kb-info-callout__title">Keep payment information secure</div>
  <p>Share transaction IDs and the last four card digits only. Never send your full card number, security code or account password.</p>
</div>
<h2>3. Request a billing review</h2>
<p>Contact support with your workspace email, both transaction IDs and the charge dates. Our team will verify the duplicate before confirming a refund. Once approved, refunds typically appear within 5–10 business days, depending on your bank.</p>
<p><a href="/knowledge-base/articles/KB-102" class="kb-article-link">Read Refund eligibility & timelines &rarr;</a></p>`,
    },
    {
      article_id: 'KB-102',
      title: 'Refund eligibility & timelines',
      slug: 'refund-eligibility-timelines',
      summary: 'Learn about our 30-day refund guarantee and processing times across payment providers.',
      category_name: 'Billing & subscriptions',
      author_name: 'Priya Nair',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      tags: ['refund', 'payments'],
      published_version: 2,
      draft_version: 2,
      has_draft_revision: false,
      published_at: '2026-10-14T11:00:00Z',
      updated_at: '2026-10-28T14:30:00Z',
      view_count: 1306,
      helpful_yes: 138,
      helpful_no: 12,
      content: `<p>We want you to be completely satisfied with your HelpDesk AI subscription. This guide covers eligibility criteria and bank delivery timelines.</p>
<h2>Refund criteria</h2>
<p>Subscriptions cancelled within 30 days of initial purchase or annual renewal qualify for a full refund. Add-on seat prorations are calculated automatically.</p>
<h2>Processing duration</h2>
<p>Credit card refunds take 5-10 business days. Wire transfers take up to 14 business days.</p>`,
    },
    {
      article_id: 'KB-103',
      title: 'Reset your account password',
      slug: 'reset-your-account-password',
      summary: 'Step-by-step instructions for resetting your forgotten password or updating credentials.',
      category_name: 'Account & security',
      author_name: 'Liam Park',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      tags: ['password', 'sign-in'],
      published_version: 1,
      draft_version: 1,
      has_draft_revision: false,
      published_at: '2026-10-10T08:00:00Z',
      updated_at: '2026-10-28T09:15:00Z',
      view_count: 2140,
      helpful_yes: 230,
      helpful_no: 10,
      content: `<p>If you cannot remember your password or want to improve account security, you can trigger a secure reset link at any time.</p>
<h2>Requesting a password reset</h2>
<p>From the login page, select "Forgot password?", enter your verified account email address, and select Send reset link.</p>
<h2>Password complexity standards</h2>
<p>Passwords must have at least 8 characters, including an uppercase letter, a number, and a special character.</p>`,
    },
    {
      article_id: 'KB-104',
      title: 'Recover access after losing your 2FA device',
      slug: 'recover-access-after-losing-your-2fa-device',
      summary: 'Securely recover your account when your authenticator is unavailable.',
      category_name: 'Account & security',
      author_name: 'Maya Chen',
      status: 'DRAFT',
      visibility: 'PUBLIC',
      tags: ['2fa', 'recovery'],
      published_version: 1,
      draft_version: 1,
      has_draft_revision: false,
      draft_saved_at: '2026-10-29T10:38:00Z',
      published_at: null,
      updated_at: '2026-10-29T10:38:00Z',
      view_count: 45,
      helpful_yes: 0,
      helpful_no: 0,
      content: `<p>Lost your authenticator or replaced your phone? Use a backup code to regain access without turning off account protection.</p>
<h2>Use a saved backup code</h2>
<p>1. Sign in with your account email and password.<br/>2. Select Try another method &rarr; Use a backup code.<br/>3. Enter one unused backup code, then select Verify.</p>
<h2>If you do not have a backup code</h2>
<p>Contact support from your registered email. Our team must verify account ownership before restoring access. Never share your password or verification codes. After recovery, set up a new authenticator and save new backup codes.</p>`,
    },
    {
      article_id: 'KB-105',
      title: 'Update invoice details and VAT number',
      slug: 'update-invoice-details-and-vat-number',
      summary: 'Add company tax identifiers, legal business name, and accounting billing address.',
      category_name: 'Billing & subscriptions',
      author_name: 'Priya Nair',
      status: 'IN_REVIEW',
      visibility: 'PUBLIC',
      tags: ['invoice', 'tax'],
      published_version: 1,
      draft_version: 1,
      has_draft_revision: false,
      published_at: null,
      updated_at: '2026-10-27T16:20:00Z',
      view_count: 120,
      helpful_yes: 12,
      helpful_no: 1,
      content: `<p>Ensure your monthly invoices reflect correct business information and tax exemption certificates.</p>
<h2>Editing tax details</h2>
<p>Navigate to Settings &rarr; Billing &rarr; Invoicing Information. Add your verified VAT or GST ID number and registered address.</p>`,
    },
    {
      article_id: 'KB-106',
      title: 'Invite teammates to your workspace',
      slug: 'invite-teammates-to-your-workspace',
      summary: 'Add team members, assign agent or admin roles, and manage permissions.',
      category_name: 'Getting started',
      author_name: 'Jonas Weber',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      tags: ['setup', 'team'],
      published_version: 1,
      draft_version: 1,
      has_draft_revision: false,
      published_at: '2026-10-18T12:00:00Z',
      updated_at: '2026-10-26T11:45:00Z',
      view_count: 980,
      helpful_yes: 92,
      helpful_no: 4,
      content: `<p>Collaboration is essential for high-throughput customer support. Invite colleagues into your organization easily.</p>
<h2>Sending team invitations</h2>
<p>Go to Team &rarr; Invite member. Input their work email address and pick between Agent and Admin permissions.</p>`,
    },
    {
      article_id: 'KB-107',
      title: 'Create and rotate an API key',
      slug: 'create-and-rotate-an-api-key',
      summary: 'Generate secure REST API tokens, set expiration windows, and rotate keys with zero downtime.',
      category_name: 'Integrations & API',
      author_name: 'Liam Park',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      tags: ['api', 'security'],
      published_version: 2,
      draft_version: 2,
      has_draft_revision: false,
      published_at: '2026-10-12T10:00:00Z',
      updated_at: '2026-10-25T15:10:00Z',
      view_count: 850,
      helpful_yes: 88,
      helpful_no: 3,
      content: `<p>Use HelpDesk AI REST API keys to automate ticket ingestion and connect custom CRM systems.</p>
<h2>Generating new keys</h2>
<p>Visit Settings &rarr; API & Webhooks. Generate a token with scoped read/write permissions.</p>`,
    },
    {
      article_id: 'KB-108',
      title: 'Legacy plan migration guide',
      slug: 'legacy-plan-migration-guide',
      summary: 'Information for customers grandfathered on v1 pricing plans transitioning to unified seats.',
      category_name: 'Billing & subscriptions',
      author_name: 'Maya Chen',
      status: 'ARCHIVED',
      visibility: 'PUBLIC',
      tags: ['legacy', 'plans'],
      published_version: 1,
      draft_version: 1,
      has_draft_revision: false,
      published_at: '2026-09-01T09:00:00Z',
      updated_at: '2026-10-21T13:00:00Z',
      view_count: 420,
      helpful_yes: 40,
      helpful_no: 8,
      content: `<p>This document details feature equivalencies and billing updates for v1 customers transitioning to the modernized plan structure.</p>`,
    },
  ];

  // Distribution to achieve exact numbers:
  // Billing & subscriptions: 18 total (15 published, 1 draft, 1 in review, 1 archived)
  // Account & security: 16 total (13 published, 2 draft, 1 in review, 0 archived)
  // Getting started: 14 total (11 published, 2 draft, 0 in review, 1 archived)
  // Integrations & API: 12 total (9 published, 1 draft, 0 in review, 2 archived)
  // Total: 60 articles (48 published, 6 draft, 2 in review, 4 archived)

  // We already have:
  // KB-101: Billing (Published) [1]
  // KB-102: Billing (Published) [2]
  // KB-103: Account (Published) [1]
  // KB-104: Account (Draft) [1]
  // KB-105: Billing (In Review) [1]
  // KB-106: Getting started (Published) [1]
  // KB-107: Integrations (Published) [1]
  // KB-108: Billing (Archived) [1]

  // Remaining needed:
  // Billing: 13 Published, 1 Draft, 0 In Review, 0 Archived (Total 14 remaining)
  // Account: 12 Published, 1 Draft, 1 In Review, 0 Archived (Total 14 remaining)
  // Getting started: 10 Published, 2 Draft, 0 In Review, 1 Archived (Total 13 remaining)
  // Integrations: 8 Published, 1 Draft, 0 In Review, 2 Archived (Total 11 remaining)
  // Sum remaining: 14 + 14 + 13 + 11 = 52 articles (KB-109 through KB-160)

  const remainingConfigs = [
    // Billing & subscriptions remaining (13 published, 1 draft)
    { cat: 'Billing & subscriptions', status: 'PUBLISHED', count: 13, author: 'Priya Nair' },
    { cat: 'Billing & subscriptions', status: 'DRAFT', count: 1, author: 'Priya Nair' },

    // Account & security remaining (12 published, 1 draft, 1 in review)
    { cat: 'Account & security', status: 'PUBLISHED', count: 12, author: 'Maya Chen' },
    { cat: 'Account & security', status: 'DRAFT', count: 1, author: 'Maya Chen' },
    { cat: 'Account & security', status: 'IN_REVIEW', count: 1, author: 'Liam Park' },

    // Getting started remaining (10 published, 2 draft, 1 archived)
    { cat: 'Getting started', status: 'PUBLISHED', count: 10, author: 'Jonas Weber' },
    { cat: 'Getting started', status: 'DRAFT', count: 2, author: 'Jonas Weber' },
    { cat: 'Getting started', status: 'ARCHIVED', count: 1, author: 'Jonas Weber' },

    // Integrations & API remaining (8 published, 1 draft, 2 archived)
    { cat: 'Integrations & API', status: 'PUBLISHED', count: 8, author: 'Liam Park' },
    { cat: 'Integrations & API', status: 'DRAFT', count: 1, author: 'Liam Park' },
    { cat: 'Integrations & API', status: 'ARCHIVED', count: 2, author: 'Liam Park' },
  ];

  let nextIdNum = 109;
  const sampleTitles = {
    'Billing & subscriptions': [
      'Annual vs monthly billing discounts and terms',
      'Download past receipt PDFs and payment statements',
      'Updating your credit card or backup payment method',
      'Understanding seat licenses and billing prorations',
      'Managing enterprise wire and ACH invoicing terms',
      'Canceling a subscription and grace period access',
      'Currency conversions and foreign transaction fees',
      'Handling declined credit card authorizations',
      'Applying promo codes and non-profit discounts',
      'Switching between Starter, Professional and Enterprise',
      'Billing notification emails and secondary billing contacts',
      'Sales tax calculation and exemption certificates',
      'Credit balances and automatic payment deductions',
      'Custom billing cycles and multi-year contract options',
    ],
    'Account & security': [
      'Setting up multi-factor authentication (TOTP/SMS)',
      'Configuring SAML single sign-on (SSO) with Okta and Azure',
      'Managing authorized devices and active browser sessions',
      'IP allowlisting for admin console and ticket management',
      'Understanding agent roles and RBAC permission sets',
      'Enforcing company-wide password hygiene and rotation policies',
      'Viewing organization security logs and audit trails',
      'Data encryption standards and GDPR/SOC2 compliance',
      'Security incident response and vulnerability reporting',
      'Session timeout thresholds and inactivity auto-lock',
      'Recovering deleted customer tickets and compliance archiving',
      'Personal data deletion requests (Right to be Forgotten)',
      'Configuring custom domain HTTPS and SSL certificates',
      'Security best practices for customer support agents',
    ],
    'Getting started': [
      'Quick start: Setting up your first support inbox',
      'Customizing email notification templates and signatures',
      'Configuring business hours and SLA response targets',
      'Setting up automatic ticket assignment rules',
      'Importing existing customer records from CSV or Zendesk',
      'Creating canned responses and ticket macros',
      'Embedding the web support messenger widget on your site',
      'Configuring ticket categories and custom field metadata',
      'Mobile app setup for iOS and Android support on the go',
      'Best practices for onboarding new customer agents',
      'Configuring automated CSAT survey triggers',
      'Workspace branding: Custom colors and company logo',
      'Setting up notification sound alerts and desktop banners',
    ],
    'Integrations & API': [
      'Connecting Slack for real-time ticket alerts and triage',
      'Integrating Jira Software for engineering escalation',
      'HubSpot CRM two-way customer contact synchronization',
      'Configuring outgoing Webhooks for ticket lifecycle events',
      'Shopify integration: Viewing customer orders inside tickets',
      'GitHub integration: Linking pull requests to bug reports',
      'Zapier connector: Automating workflows with 5,000+ apps',
      'Using the GraphQL API for custom reporting and warehouse sync',
      'Rate limits, headers and retry guidelines for API developers',
      'Salesforce integration: Account mapping and case sync',
      'Postman collection and environment quickstart guide',
    ],
  };

  const titleIndexes = {
    'Billing & subscriptions': 0,
    'Account & security': 0,
    'Getting started': 0,
    'Integrations & API': 0,
  };

  for (const group of remainingConfigs) {
    for (let i = 0; i < group.count; i++) {
      const artId = `KB-${nextIdNum++}`;
      const titleList = sampleTitles[group.cat] || [];
      const title = titleList[titleIndexes[group.cat]++] || `${group.cat} guide ${artId}`;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      const isPublished = group.status === 'PUBLISHED';
      const views = isPublished ? Math.floor(100 + Math.random() * 900) : Math.floor(10 + Math.random() * 50);
      const helpfulRate = 0.88 + Math.random() * 0.1;
      const totalRatings = isPublished ? Math.floor(views * 0.12) : 0;
      const helpfulYes = Math.round(totalRatings * helpfulRate);
      const helpfulNo = totalRatings - helpfulYes;

      articlesList.push({
        article_id: artId,
        title,
        slug: `${slug}-${artId.toLowerCase()}`,
        summary: `Comprehensive documentation and instructions for ${title.toLowerCase()}.`,
        category_name: group.cat,
        author_name: group.author,
        status: group.status,
        visibility: 'PUBLIC',
        tags: [group.cat.split(' ')[0].toLowerCase(), 'guide'],
        published_version: 1,
        draft_version: 1,
        has_draft_revision: false,
        published_at: isPublished ? '2026-10-20T10:00:00Z' : null,
        updated_at: '2026-10-25T12:00:00Z',
        view_count: views,
        helpful_yes: helpfulYes,
        helpful_no: helpfulNo,
        content: `<p>This comprehensive guide details everything you need to know about ${title.toLowerCase()}.</p>
<h2>Overview and prerequisites</h2>
<p>Ensure you have appropriate permissions configured in your workspace before continuing.</p>
<h2>Step-by-step instructions</h2>
<p>Follow the outlined guidelines to ensure smooth operation across your team.</p>`,
      });
    }
  }

  console.log(`Generated ${articlesList.length} articles to insert.`);

  // Insert all articles into database
  for (const art of articlesList) {
    const catId = categoryMap[art.category_name];
    const authorId = userMap[art.author_name] || userMap['Maya Chen'];

    const res = await database.query(
      `INSERT INTO kb_articles (
        article_id, title, slug, summary, content, category_id, author_id,
        status, visibility, tags, published_version, draft_version,
        has_draft_revision, draft_title, draft_summary, draft_content, draft_saved_at,
        published_at, updated_at, view_count, helpful_yes, helpful_no
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22
      ) RETURNING id`,
      [
        art.article_id,
        art.title,
        art.slug,
        art.summary,
        art.content,
        catId,
        authorId,
        art.status,
        art.visibility,
        art.tags,
        art.published_version,
        art.draft_version,
        art.has_draft_revision || false,
        art.draft_title || art.title,
        art.draft_summary || art.summary,
        art.draft_content || art.content,
        art.draft_saved_at || null,
        art.published_at,
        art.updated_at,
        art.view_count,
        art.helpful_yes,
        art.helpful_no,
      ]
    );

    const insertedId = res.rows[0].id;
    // Insert initial version record for published articles
    if (art.status === 'PUBLISHED') {
      await database.query(
        `INSERT INTO kb_article_versions (article_id, version, title, summary, content, published_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          insertedId,
          art.published_version,
          art.title,
          art.summary,
          art.content,
          authorId,
          art.published_at || '2026-10-15T09:00:00Z',
        ]
      );
    }
  }

  // Verify total counts
  const countRes = await database.query(`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE status = 'DRAFT') as draft,
      count(*) FILTER (WHERE status = 'IN_REVIEW') as in_review,
      count(*) FILTER (WHERE status = 'ARCHIVED') as archived
    FROM kb_articles
  `);
  console.log('Knowledge Base seeded counts:', countRes.rows[0]);

  const catCounts = await database.query(`
    SELECT c.name, count(a.id) as total, count(a.id) FILTER (WHERE a.status = 'PUBLISHED') as published
    FROM kb_categories c
    LEFT JOIN kb_articles a ON a.category_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.display_order ASC
  `);
  console.log('Category article counts:', catCounts.rows);

  console.log('Seeding completed successfully!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});

