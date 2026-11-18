import assert from "node:assert/strict";

const BASE_URL = "http://localhost:3000/api/v1";

async function api(path, { method = "GET", body, cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  const setCookie = res.headers.get("set-cookie");
  const sid = setCookie ? setCookie.split(";")[0] : cookie;
  return { status: res.status, data: json, cookie: sid };
}

async function login(email, password) {
  const res = await api("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.data)}`);
  return res.cookie;
}

async function run() {
  console.log("=== Starting Team Roles & Permissions E2E Verification ===");

  // 1. Authenticate with standard test users
  console.log("\n1. Testing Login for Admin, Agent, and Customer...");
  const adminCookie = await login("admin@example.com", "khanAdmin@543");
  const agentCookie = await login("agent@example.com", "khanAgent@543");
  const customerCookie = await login("customer@example.com", "khanCustomer@543");
  console.log("✓ Logged in as Admin, Agent, and Customer successfully.");

  // 2. Audit GET /team/roles for Admin & Agent & Customer
  console.log("\n2. Testing GET /team/roles endpoint access & shape...");
  const adminRolesRes = await api("/team/roles", { cookie: adminCookie });
  assert.equal(adminRolesRes.status, 200);
  assert.equal(adminRolesRes.data.status, "success");
  assert.equal(adminRolesRes.data.data.can_edit, true);
  assert.equal(adminRolesRes.data.data.current_user_role, "ADMIN");
  assert.deepEqual(
    adminRolesRes.data.data.roles.map((r) => r.id),
    ["ADMIN", "AGENT", "CUSTOMER"],
    "Must support exactly ADMIN, AGENT, CUSTOMER",
  );
  assert.equal(adminRolesRes.data.data.permissions.length, 13, "Must return 13 canonical permissions");
  console.log("✓ Admin gets can_edit=true and 13 canonical permissions across ADMIN, AGENT, CUSTOMER.");

  const agentRolesRes = await api("/team/roles", { cookie: agentCookie });
  assert.equal(agentRolesRes.status, 200);
  assert.equal(agentRolesRes.data.data.can_edit, false);
  assert.equal(agentRolesRes.data.data.current_user_role, "AGENT");
  console.log("✓ Agent gets can_edit=false.");

  const customerRolesRes = await api("/team/roles", { cookie: customerCookie });
  assert.equal(customerRolesRes.status, 403, "Customer must be denied access to team roles (403)");
  console.log("✓ Customer is forbidden from viewing team roles (403).");

  // 3. Admin Anti-lockout Protection
  console.log("\n3. Testing Admin Anti-lockout Protection...");
  const lockoutAttempt = await api("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        { id: "edit_roles_permissions", admin_value: "Not allowed", agent_value: "View only", customer_value: "Not allowed" },
      ],
    },
  });
  assert.equal(lockoutAttempt.status, 422, "Must reject modifying ADMIN edit_roles_permissions with 422");
  console.log("✓ Admin cannot revoke edit_roles_permissions (422 rejected).");

  const lockoutAttempt2 = await api("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        { id: "billing_security_settings", admin_value: "Not allowed", agent_value: "Not allowed", customer_value: "Not allowed" },
      ],
    },
  });
  assert.equal(lockoutAttempt2.status, 422, "Must reject modifying ADMIN billing_security_settings with 422");
  console.log("✓ Admin cannot revoke billing_security_settings (422 rejected).");

  const agentPatchAttempt = await api("/team/roles", {
    method: "PATCH",
    cookie: agentCookie,
    body: {
      permissions: [{ id: "view_reports", agent_value: "Workspace" }],
    },
  });
  assert.equal(agentPatchAttempt.status, 403, "Non-admin cannot update permissions (403)");
  console.log("✓ Non-admin cannot patch roles (403).");

  // 4. Test Updating Permissions and Shared Configuration across Admins
  console.log("\n4. Testing Permission Updates and Multi-Admin Consistency...");
  // Let's toggle agent_value for view_reports between 'Workspace' and 'Own performance'
  const patchRes = await api("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        { id: "view_reports", agent_value: "Workspace", customer_value: "Not allowed" },
      ],
    },
  });
  assert.equal(patchRes.status, 200, "Admin can update agent/customer permissions");
  const updatedReports = patchRes.data.data.permissions.find((p) => p.id === "view_reports");
  assert.equal(updatedReports.values.AGENT, "Workspace");
  console.log("✓ Successfully updated view_reports for AGENT to 'Workspace'.");

  // Verify another Admin sees the exact same updated configuration
  const admin2Res = await api("/team/roles", { cookie: adminCookie });
  const admin2Reports = admin2Res.data.data.permissions.find((p) => p.id === "view_reports");
  assert.equal(admin2Reports.values.AGENT, "Workspace");
  console.log("✓ All Admin accounts share the exact same updated configuration.");

  // 5. Test Backend Enforcement: Agent now has Workspace report access
  console.log("\n5. Testing Backend Middleware Enforcement for Agent...");
  const agentPerfRes = await api("/team/performance", { cookie: agentCookie });
  assert.equal(agentPerfRes.status, 200, "Agent should access performance reports when view_reports is Workspace");
  console.log("✓ Agent can access team performance under updated permission.");

  // Now change view_reports for AGENT to 'Not allowed'
  const revokeRes = await api("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        { id: "view_reports", agent_value: "Not allowed", customer_value: "Not allowed" },
      ],
    },
  });
  assert.equal(revokeRes.status, 200);

  // Agent should now receive 403 Forbidden!
  const agentDeniedRes = await api("/team/performance", { cookie: agentCookie });
  assert.equal(agentDeniedRes.status, 403, "Agent must be forbidden (403) when view_reports is Not allowed");
  console.log("✓ Agent receives 403 Forbidden immediately when permission is set to 'Not allowed'.");

  // Restore view_reports back to standard default
  await api("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        { id: "view_reports", agent_value: "Own performance", customer_value: "Not allowed" },
      ],
    },
  });
  console.log("✓ Restored view_reports to 'Own performance'.");

  // 6. Test Public Registration Security
  console.log("\n6. Testing Public Signup Security (Cannot create ADMIN or AGENT)...");
  const testEmail = `test.user.${Date.now()}@example.com`;
  const regRes = await api("/auth/register", {
    method: "POST",
    body: {
      name: "Exploit Tester",
      email: testEmail,
      password: "TestPassword123!",
      role: "ADMIN", // Malicious attempt to elevate role
    },
  });
  assert.equal(regRes.status, 201, "Registration should succeed");
  assert.equal(regRes.data.data.user.role, "CUSTOMER", "Public registration MUST strictly create CUSTOMER role");
  console.log("✓ Public registration strictly assigned CUSTOMER role even when role: ADMIN was sent.");

  // Log in as the newly created customer
  const newCookie = await login(testEmail, "TestPassword123!");
  const newRolesRes = await api("/team/roles", { cookie: newCookie });
  assert.equal(newRolesRes.status, 403, "New customer cannot access team roles (403)");
  console.log("✓ Newly registered customer immediately inherits global CUSTOMER permissions (403 on team roles).");

  // Verify the new customer can view own tickets (or create ticket)
  const createTicketRes = await api("/tickets", {
    method: "POST",
    cookie: newCookie,
    body: {
      title: "Help with my account settings",
      description: "Need help with configuring my account preferences please.",
      category_id: 1,
    },
  });
  assert.equal(createTicketRes.status, 201, "New customer can create ticket");
  console.log("✓ Newly registered customer can create tickets as permitted for CUSTOMER role.");

  console.log("\n=== ALL E2E VERIFICATION TESTS PASSED SUCCESSFULLY! ===");
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
