/**
 * verify_all_13_permissions.mjs
 *
 * Exhaustive End-to-End Verification for all 13 Permissions across ADMIN, AGENT, and CUSTOMER.
 * Tests:
 * 1. create_tickets
 * 2. view_tickets
 * 3. reply_tickets
 * 4. internal_notes
 * 5. update_status
 * 6. assign_reassign_tickets
 * 7. ticket_history
 * 8. ai_tools
 * 9. publish_kb
 * 10. view_reports
 * 11. invite_members
 * 12. edit_roles_permissions
 * 13. billing_security_settings
 *
 * Plus:
 * - Admin anti-lockout protections (422)
 * - Server-side payload validation (unknown keys / invalid enum values -> 422)
 * - Effective permissions on GET /auth/me for all roles
 * - Freshness and cache invalidation on PATCH
 * - Restoration of original matrix state
 */

const BASE_URL = 'http://localhost:3000/api/v1';

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = null;
    this.user = null;
  }

  async post(path, body = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    this._captureCookie(res);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  }

  async patch(path, body = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    this._captureCookie(res);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  }

  async get(path) {
    const headers = {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers,
    });
    this._captureCookie(res);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  }

  _captureCookie(res) {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/helpdesk\.sid=[^;]+/);
      if (match) this.cookie = match[0];
    }
  }

  async login(email, password) {
    const res = await this.post('/auth/login', { email, password });
    if (!res.ok) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.data)}`);
    this.user = res.data?.data?.user || res.data?.user;
    return this.user;
  }

  async me() {
    const res = await this.get('/auth/me');
    if (!res.ok) throw new Error(`Me failed for ${this.name}: ${res.status}`);
    this.user = res.data?.data?.user || res.data?.user;
    return this.user;
  }
}

async function main() {
  console.log('================================================================');
  console.log('   FULL E2E VERIFICATION: ALL 13 PERMISSIONS ACROSS ROLES');
  console.log('================================================================\n');

  const admin = new Client('Admin');
  const agent = new Client('Agent');
  const customer = new Client('Customer');

  await admin.login('admin@example.com', 'khanAdmin@543');
  await agent.login('agent@example.com', 'khanAgent@543');
  await customer.login('customer@example.com', 'khanCustomer@543');
  console.log('✓ All 3 roles authenticated successfully.');

  // Fetch initial matrix
  const initialRolesRes = await admin.get('/team/roles');
  if (!initialRolesRes.ok) throw new Error('Failed to get initial roles matrix');
  const initialPermissions = initialRolesRes.data.data.permissions;
  console.log(`✓ Fetched current matrix with ${initialPermissions.length} canonical permissions.\n`);

  const results = [];

  function record(permission, role, testName, passed, details = '') {
    results.push({ permission, role, testName, passed, details });
    const mark = passed ? '✓' : '✗';
    console.log(`  ${mark} [${permission}][${role}] ${testName} ${details ? '(' + details + ')' : ''}`);
  }

  // Helper to patch single permission
  async function setMatrix(permissionId, roleKey, value) {
    const patchRes = await admin.patch('/team/roles', {
      permissions: [
        { id: permissionId, values: { [roleKey]: value } }
      ]
    });
    return patchRes;
  }

  // -------------------------------------------------------------
  // Test 1: create_tickets
  // -------------------------------------------------------------
  console.log('\n--- 1. Testing Permission: create_tickets ---');
  // Disallow Customer
  let patchRes = await setMatrix('create_tickets', 'CUSTOMER', 'Not allowed');
  record('create_tickets', 'ADMIN', 'Save Customer=Not allowed', patchRes.status === 200);

  let custMe = await customer.me();
  record('create_tickets', 'CUSTOMER', 'Effective permission reflects Not allowed on /auth/me', custMe.permissions?.create_tickets === 'Not allowed');

  let custCreate = await customer.post('/tickets', {
    title: 'Should fail create',
    description: 'Testing create_tickets blocked for customer'
  });
  record('create_tickets', 'CUSTOMER', 'POST /tickets blocked with 403', custCreate.status === 403);

  // Re-allow Customer
  await setMatrix('create_tickets', 'CUSTOMER', 'Allowed');
  custMe = await customer.me();
  record('create_tickets', 'CUSTOMER', 'Effective permission restored to Allowed on /auth/me', custMe.permissions?.create_tickets === 'Allowed');

  custCreate = await customer.post('/tickets', {
    title: 'Customer allowed ticket',
    description: 'Testing create_tickets permitted for customer'
  });
  const createdCustTicketId = custCreate.data?.data?.ticket?.id || custCreate.data?.ticket?.id;
  record('create_tickets', 'CUSTOMER', 'POST /tickets allowed (201)', custCreate.status === 201, `Ticket ID: ${createdCustTicketId}`);

  // Test Agent create_tickets (Set to Not allowed first)
  await setMatrix('create_tickets', 'AGENT', 'Not allowed');
  let agentCreate = await agent.post('/tickets', {
    title: 'Agent should fail create by default',
    description: 'Agent create_tickets is Not allowed'
  });
  record('create_tickets', 'AGENT', 'Agent create blocked with 403 when Not allowed', agentCreate.status === 403);

  await setMatrix('create_tickets', 'AGENT', 'Allowed');
  let agentMe = await agent.me();
  record('create_tickets', 'AGENT', 'Effective permission reflects Allowed on /auth/me', agentMe.permissions?.create_tickets === 'Allowed');

  agentCreate = await agent.post('/tickets', {
    title: 'Agent allowed ticket',
    description: 'Agent create_tickets is now Allowed'
  });
  record('create_tickets', 'AGENT', 'Agent create allowed (201) when matrix set to Allowed', agentCreate.status === 201);
  await setMatrix('create_tickets', 'AGENT', 'Not allowed'); // restore

  // -------------------------------------------------------------
  // Test 2: view_tickets
  // -------------------------------------------------------------
  console.log('\n--- 2. Testing Permission: view_tickets ---');
  await setMatrix('view_tickets', 'AGENT', 'All tickets');
  agentMe = await agent.me();
  record('view_tickets', 'AGENT', 'Scope reflects ALL on /auth/me', agentMe.permission_scopes?.view_tickets === 'ALL');

  let agentTicketsAll = await agent.get('/tickets');
  record('view_tickets', 'AGENT', 'GET /tickets returns tickets under ALL scope', agentTicketsAll.status === 200);

  await setMatrix('view_tickets', 'AGENT', 'Assigned tickets');
  agentMe = await agent.me();
  record('view_tickets', 'AGENT', 'Scope restored to ASSIGNED on /auth/me', agentMe.permission_scopes?.view_tickets === 'ASSIGNED');

  custMe = await customer.me();
  record('view_tickets', 'CUSTOMER', 'Customer view scope is OWN on /auth/me', custMe.permission_scopes?.view_tickets === 'OWN');

  // -------------------------------------------------------------
  // Test 3: reply_tickets
  // -------------------------------------------------------------
  console.log('\n--- 3. Testing Permission: reply_tickets ---');
  if (createdCustTicketId) {
    // When reply_tickets is Own tickets, customer can reply to their ticket
    let custReply = await customer.post(`/tickets/${createdCustTicketId}/comments`, {
      message: 'Customer allowed reply'
    });
    record('reply_tickets', 'CUSTOMER', 'POST /comments allowed (201) for ticket owner', custReply.status === 201);

    // Agent reply scoping:
    await setMatrix('reply_tickets', 'AGENT', 'All tickets');
    let agentReply = await agent.post(`/tickets/${createdCustTicketId}/comments`, {
      message: 'Agent reply allowed under All tickets'
    });
    record('reply_tickets', 'AGENT', 'Agent reply allowed (201) when matrix set to All tickets', agentReply.status === 201);
    await setMatrix('reply_tickets', 'AGENT', 'Assigned tickets'); // restore
  }

  // -------------------------------------------------------------
  // Test 4: internal_notes
  // -------------------------------------------------------------
  console.log('\n--- 4. Testing Permission: internal_notes ---');
  if (createdCustTicketId) {
    // Assign ticket to agent so agent has ticket access under Assigned tickets scope
    await admin.patch(`/tickets/${createdCustTicketId}/assignment`, { assigned_agent_id: agent.user.id });

    // Customer must always be blocked from internal notes
    let custInternal = await customer.post(`/tickets/${createdCustTicketId}/comments`, {
      message: 'Customer trying internal note',
      is_internal: true
    });
    record('internal_notes', 'CUSTOMER', 'Customer cannot post internal notes (403)', custInternal.status === 403);

    // Agent internal notes Allowed vs Not allowed
    await setMatrix('internal_notes', 'AGENT', 'Allowed');
    let agentNote = await agent.post(`/tickets/${createdCustTicketId}/comments`, {
      message: 'Agent internal note allowed',
      is_internal: true
    });
    record('internal_notes', 'AGENT', 'Agent can post internal note when Allowed (201)', agentNote.status === 201);

    await setMatrix('internal_notes', 'AGENT', 'Not allowed');
    agentMe = await agent.me();
    record('internal_notes', 'AGENT', 'Effective permission reflects Not allowed on /auth/me', agentMe.permissions?.internal_notes === 'Not allowed');

    agentNote = await agent.post(`/tickets/${createdCustTicketId}/comments`, {
      message: 'Agent internal note should fail',
      is_internal: true
    });
    record('internal_notes', 'AGENT', 'Agent internal note blocked with 403 when Not allowed', agentNote.status === 403);
    await setMatrix('internal_notes', 'AGENT', 'Allowed'); // restore
  }

  // -------------------------------------------------------------
  // Test 5: update_status (Status updates)
  // -------------------------------------------------------------
  console.log('\n--- 5. Testing Permission: update_status ---');
  if (createdCustTicketId) {
    await setMatrix('update_status', 'AGENT', 'Not allowed');
    let agentStatus = await agent.patch(`/tickets/${createdCustTicketId}/status`, { status: 'IN_PROGRESS' });
    record('update_status', 'AGENT', 'Agent status update blocked with 403 when Not allowed', agentStatus.status === 403);

    let agentBulkStatus = await agent.post('/tickets/bulk/status', {
      ticket_ids: [createdCustTicketId],
      status: 'IN_PROGRESS'
    });
    record('update_status', 'AGENT', 'Agent bulk status update blocked with 403 when Not allowed', agentBulkStatus.status === 403);

    await setMatrix('update_status', 'AGENT', 'All tickets');
    agentStatus = await agent.patch(`/tickets/${createdCustTicketId}/status`, { status: 'IN_PROGRESS' });
    record('update_status', 'AGENT', 'Agent status update allowed (200) when set to All tickets', agentStatus.status === 200);
    await setMatrix('update_status', 'AGENT', 'Assigned tickets'); // restore
  }

  // -------------------------------------------------------------
  // Test 6: assign_reassign_tickets
  // -------------------------------------------------------------
  console.log('\n--- 6. Testing Permission: assign_reassign_tickets ---');
  if (createdCustTicketId) {
    await setMatrix('assign_reassign_tickets', 'AGENT', 'Not allowed');
    let agentAssign = await agent.patch(`/tickets/${createdCustTicketId}/assignment`, { assigned_agent_id: agent.user.id });
    record('assign_reassign_tickets', 'AGENT', 'Agent assign blocked with 403 when Not allowed', agentAssign.status === 403);

    let agentBulkAssign = await agent.post('/tickets/bulk/assign', {
      ticket_ids: [createdCustTicketId],
      assigned_to: agent.user.id
    });
    record('assign_reassign_tickets', 'AGENT', 'Agent bulk assign blocked with 403 when Not allowed', agentBulkAssign.status === 403);

    await setMatrix('assign_reassign_tickets', 'AGENT', 'Allowed');
    agentAssign = await agent.patch(`/tickets/${createdCustTicketId}/assignment`, { assigned_agent_id: agent.user.id });
    record('assign_reassign_tickets', 'AGENT', 'Agent assign allowed (200) when set to Allowed', agentAssign.status === 200);
    await setMatrix('assign_reassign_tickets', 'AGENT', 'Not allowed'); // restore
  }

  // -------------------------------------------------------------
  // Test 7: ticket_history
  // -------------------------------------------------------------
  console.log('\n--- 7. Testing Permission: ticket_history ---');
  if (createdCustTicketId) {
    await setMatrix('ticket_history', 'AGENT', 'Not allowed');
    let agentHist = await agent.get(`/tickets/${createdCustTicketId}/history`);
    record('ticket_history', 'AGENT', 'Agent activities/history blocked with 403 when Not allowed', agentHist.status === 403);

    await setMatrix('ticket_history', 'AGENT', 'All tickets');
    agentHist = await agent.get(`/tickets/${createdCustTicketId}/history`);
    record('ticket_history', 'AGENT', 'Agent activities allowed (200) when set to All tickets', agentHist.status === 200);
    await setMatrix('ticket_history', 'AGENT', 'Assigned tickets'); // restore
  }

  // -------------------------------------------------------------
  // Test 8: ai_tools
  // -------------------------------------------------------------
  console.log('\n--- 8. Testing Permission: ai_tools ---');
  if (createdCustTicketId) {
    await setMatrix('ai_tools', 'AGENT', 'Not allowed');
    agentMe = await agent.me();
    record('ai_tools', 'AGENT', 'Scope reflects NONE on /auth/me when Not allowed', agentMe.permission_scopes?.ai_tools === 'NONE');

    let agentAi = await agent.post(`/tickets/${createdCustTicketId}/ai/classify`, {});
    record('ai_tools', 'AGENT', 'Agent AI tool blocked with 403 when Not allowed', agentAi.status === 403);

    await setMatrix('ai_tools', 'AGENT', 'All tickets');
    agentMe = await agent.me();
    record('ai_tools', 'AGENT', 'Scope reflects ALL on /auth/me when set to All tickets', agentMe.permission_scopes?.ai_tools === 'ALL');
    await setMatrix('ai_tools', 'AGENT', 'Assigned tickets'); // restore
  }

  // -------------------------------------------------------------
  // Test 9: publish_kb
  // -------------------------------------------------------------
  console.log('\n--- 9. Testing Permission: publish_kb ---');
  await setMatrix('publish_kb', 'AGENT', 'View only');
  let agentKbCreate = await agent.post('/kb/articles', {
    title: 'Should fail KB publish',
    content: 'Draft content'
  });
  record('publish_kb', 'AGENT', 'Agent KB article creation blocked with 403 when View only', agentKbCreate.status === 403);

  await setMatrix('publish_kb', 'AGENT', 'Publish & edit');
  agentMe = await agent.me();
  record('publish_kb', 'AGENT', 'Effective permission reflects Publish & edit on /auth/me', agentMe.permissions?.publish_kb === 'Publish & edit');

  // Customer publish_kb is always View only
  let custKbCreate = await customer.post('/kb/articles', {
    title: 'Customer should fail KB publish',
    content: 'Draft content'
  });
  record('publish_kb', 'CUSTOMER', 'Customer KB creation blocked with 403', custKbCreate.status === 403);

  // -------------------------------------------------------------
  // Test 10: view_reports
  // -------------------------------------------------------------
  console.log('\n--- 10. Testing Permission: view_reports ---');
  await setMatrix('view_reports', 'AGENT', 'Not allowed');
  let agentRep = await agent.get('/team/performance');
  record('view_reports', 'AGENT', 'Agent team performance blocked with 403 when Not allowed', agentRep.status === 403);

  await setMatrix('view_reports', 'AGENT', 'Own performance');
  agentRep = await agent.get('/team/performance');
  record('view_reports', 'AGENT', 'Agent team performance allowed (200) when Own performance', agentRep.status === 200);

  await setMatrix('view_reports', 'AGENT', 'Workspace');
  agentRep = await agent.get('/team/performance');
  record('view_reports', 'AGENT', 'Agent team performance allowed (200) when Workspace', agentRep.status === 200);
  await setMatrix('view_reports', 'AGENT', 'Own performance'); // restore

  // Customer view_reports
  let custRep = await customer.get('/team/performance');
  record('view_reports', 'CUSTOMER', 'Customer performance view blocked with 403', custRep.status === 403);

  // -------------------------------------------------------------
  // Test 11: invite_members
  // -------------------------------------------------------------
  console.log('\n--- 11. Testing Permission: invite_members ---');
  let agentInvite = await agent.get('/team/invite-options');
  record('invite_members', 'AGENT', 'Agent member invitation options blocked with 403 by default', agentInvite.status === 403);

  let custInvite = await customer.get('/team/invite-options');
  record('invite_members', 'CUSTOMER', 'Customer member invitation options blocked with 403', custInvite.status === 403);

  // Anti-lockout test for invite_members on Admin
  let adminLockoutInvite = await setMatrix('invite_members', 'ADMIN', 'Not allowed');
  record('invite_members', 'ADMIN', 'Admin lockout protection rejects removing invite_members (422)', adminLockoutInvite.status === 422);

  // -------------------------------------------------------------
  // Test 12: edit_roles_permissions
  // -------------------------------------------------------------
  console.log('\n--- 12. Testing Permission: edit_roles_permissions ---');
  let agentRolesGet = await agent.get('/team/roles');
  record('edit_roles_permissions', 'AGENT', 'Agent can view roles matrix (200) with can_edit=false', agentRolesGet.status === 200 && agentRolesGet.data?.data?.can_edit === false);

  let agentRolesPatch = await agent.patch('/team/roles', {
    permissions: [{ id: 'view_reports', values: { AGENT: 'Workspace' } }]
  });
  record('edit_roles_permissions', 'AGENT', 'Agent cannot modify roles matrix (403)', agentRolesPatch.status === 403);

  let adminLockoutRoles = await setMatrix('edit_roles_permissions', 'ADMIN', 'Not allowed');
  record('edit_roles_permissions', 'ADMIN', 'Admin lockout protection rejects removing edit_roles_permissions (422)', adminLockoutRoles.status === 422);

  // -------------------------------------------------------------
  // Test 13: billing_security_settings
  // -------------------------------------------------------------
  console.log('\n--- 13. Testing Permission: billing_security_settings ---');
  let agentSettingsPatch = await agent.patch('/settings/workspace', { workspace_name: 'Hacked' });
  record('billing_security_settings', 'AGENT', 'Agent cannot modify settings (403)', agentSettingsPatch.status === 403);

  let adminLockoutSettings = await setMatrix('billing_security_settings', 'ADMIN', 'Not allowed');
  record('billing_security_settings', 'ADMIN', 'Admin lockout protection rejects removing billing_security_settings (422)', adminLockoutSettings.status === 422);

  // -------------------------------------------------------------
  // Validation Tests: Unknown keys & Invalid enums
  // -------------------------------------------------------------
  console.log('\n--- Validation & Tamper Protection ---');
  let invalidEnum = await admin.patch('/team/roles', {
    permissions: [{ id: 'create_tickets', values: { CUSTOMER: 'SuperUser' } }]
  });
  record('validation', 'ADMIN', 'Rejects invalid permission value enum with 422', invalidEnum.status === 422);

  let unknownKey = await admin.patch('/team/roles', {
    permissions: [{ id: 'non_existent_perm', values: { CUSTOMER: 'Allowed' } }]
  });
  record('validation', 'ADMIN', 'Rejects unknown permission id with 422', unknownKey.status === 422);

  let unknownRootKey = await admin.patch('/team/roles', {
    permissions: [],
    malicious_field: true
  });
  record('validation', 'ADMIN', 'Rejects unknown root payload properties with 422', unknownRootKey.status === 422);

  // -------------------------------------------------------------
  // Cleanup: Restore canonical matrix
  // -------------------------------------------------------------
  console.log('\n--- Restoring Canonical Matrix ---');
  const restorePayload = initialPermissions.map(p => ({
    id: p.id,
    values: p.values
  }));
  const restoreRes = await admin.patch('/team/roles', { permissions: restorePayload });
  console.log(`✓ Restored canonical matrix: status ${restoreRes.status}`);

  console.log('\n================================================================');
  console.log(`SUMMARY: ${results.filter(r => r.passed).length} / ${results.length} tests passed.`);
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach(f => console.error(`- [${f.permission}][${f.role}] ${f.testName} (${f.details})`));
    process.exit(1);
  } else {
    console.log('ALL 13 PERMISSIONS AND SECURITY PROTECTIONS FULLY VERIFIED!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error in verification script:', err);
  process.exit(1);
});
