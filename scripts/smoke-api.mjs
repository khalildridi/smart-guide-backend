const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:4000";

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function expectOkJson(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText} ${body}`);
  }
  return resp.json();
}

async function run() {
  await check("GET /api/health", async () => {
    const data = await expectOkJson(`${baseUrl}/api/health`);
    if (data?.status !== "ok") throw new Error("Unexpected health status");
  });

  await check("GET /api/supabase/health", async () => {
    const data = await expectOkJson(`${baseUrl}/api/supabase/health`);
    if (!("status" in data) && !("supabase" in data)) {
      throw new Error("Unexpected supabase health payload");
    }
  });

  await check("POST /api/supabase/proxy plans", async () => {
    const resp = await fetch(`${baseUrl}/api/supabase/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "rest/v1/plans?select=id&limit=1",
        method: "GET",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${resp.status} ${resp.statusText} ${body}`);
    }
  });

  console.log("Smoke API checks completed successfully.");
}

run().catch(() => {
  process.exit(1);
});
