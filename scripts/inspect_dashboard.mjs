const login = async (email, password) => {
  const res = await fetch("http://localhost:3000/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.headers.get("set-cookie")?.split(";")[0];
};

const run = async () => {
  for (const [role, email, pass] of [
    ["ADMIN", "admin@example.com", "khanAdmin@543"],
    ["AGENT", "agent@example.com", "khanAgent@543"],
    ["CUSTOMER", "customer@example.com", "khanCustomer@543"],
  ]) {
    const cookie = await login(email, pass);
    const res = await fetch("http://localhost:3000/api/v1/dashboard", {
      headers: { Cookie: cookie },
    });
    const data = await res.json();
    console.log(`\n=== ${role} DASHBOARD RESPONSE ===`);
    console.log("total_tickets:", data.data?.dashboard?.total_tickets);
    console.log("status_counts:", data.data?.dashboard?.status_counts);
    console.log("priority_counts:", data.data?.dashboard?.priority_counts);
    console.log("recent_tickets count:", data.data?.dashboard?.recent_tickets?.length);
    console.log("pagination:", data.data?.dashboard?.pagination);
    if (role === "ADMIN") {
      console.log("category_counts count:", data.data?.dashboard?.category_counts?.length);
      console.log("agent_workload count:", data.data?.dashboard?.agent_workload?.length);
      console.log("sample agent_workload:", data.data?.dashboard?.agent_workload?.slice(0, 2));
    }
    console.log("all top-level keys:", Object.keys(data.data?.dashboard || {}));
  }
};
run();
