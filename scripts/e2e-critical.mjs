import dotenv from "dotenv";

dotenv.config();

const backendBaseUrl = process.env.E2E_BASE_URL || "http://localhost:4000";
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY;

const e2eEmail = process.env.E2E_USER_EMAIL;
const e2ePassword = process.env.E2E_USER_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase config. Set SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_ANON_KEY/VITE_SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

if (!e2eEmail || !e2ePassword) {
  console.error("Missing E2E test credentials. Set E2E_USER_EMAIL and E2E_USER_PASSWORD.");
  process.exit(1);
}

async function expectJson(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} ${text}`);
  }
  return data;
}

async function loginWithPassword() {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({
      email: e2eEmail,
      password: e2ePassword,
    }),
  });
  const data = await expectJson(response);
  if (!data.access_token || !data.user?.id) {
    throw new Error("Login failed: missing access_token/user.");
  }
  return { accessToken: data.access_token, userId: data.user.id };
}

async function callBackend(pathname, init = {}) {
  return fetch(`${backendBaseUrl}${pathname}`, init);
}

async function run() {
  const created = {
    reviewId: null,
    listId: null,
    planId: null,
  };

  const { accessToken, userId } = await loginWithPassword();
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  try {
    const healthResp = await callBackend("/api/health");
    await expectJson(healthResp);
    console.log("PASS health");

    const plansResp = await callBackend("/api/supabase/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "rest/v1/plans?select=id&limit=1", method: "GET" }),
    });
    const plans = await expectJson(plansResp);
    const planId = Array.isArray(plans) && plans[0]?.id;
    if (!planId) throw new Error("No plan found for E2E tests.");
    created.planId = planId;
    console.log("PASS get plan");

    const ensureResp = await callBackend("/api/supabase/db/profiles/ensure", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
    });
    await expectJson(ensureResp);
    console.log("PASS profile ensure");

    const addFavoriteResp = await callBackend("/api/supabase/db/favorites", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: created.planId }),
    });
    await expectJson(addFavoriteResp);
    console.log("PASS favorite add");

    const removeFavoriteResp = await callBackend("/api/supabase/db/favorites", {
      method: "DELETE",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: created.planId }),
    });
    if (!removeFavoriteResp.ok && removeFavoriteResp.status !== 204) {
      await expectJson(removeFavoriteResp);
    }
    console.log("PASS favorite remove");

    const listName = `E2E-${Date.now()}`;
    const createListResp = await callBackend("/api/supabase/db/user_lists", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: listName, description: "E2E list", icon: "folder", color: "primary" }),
    });
    const createdList = await expectJson(createListResp);
    created.listId = createdList.id;
    if (!created.listId) throw new Error("Failed to create list.");
    console.log("PASS list create");

    const addListItemResp = await callBackend("/api/supabase/db/list_items", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ list_id: created.listId, plan_id: created.planId }),
    });
    await expectJson(addListItemResp);
    console.log("PASS list item add");

    const removeListItemResp = await callBackend("/api/supabase/db/list_items", {
      method: "DELETE",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ list_id: created.listId, plan_id: created.planId }),
    });
    if (!removeListItemResp.ok && removeListItemResp.status !== 204) {
      await expectJson(removeListItemResp);
    }
    console.log("PASS list item remove");

    const deleteListResp = await callBackend(`/api/supabase/db/user_lists/${encodeURIComponent(created.listId)}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!deleteListResp.ok && deleteListResp.status !== 204) {
      await expectJson(deleteListResp);
    }
    created.listId = null;
    console.log("PASS list delete");

    const reviewResp = await callBackend("/api/supabase/db/reviews", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: created.planId,
        rating: 5,
        comment: `E2E review ${new Date().toISOString()}`,
        is_bad_plan_report: false,
      }),
    });
    const review = await expectJson(reviewResp);
    created.reviewId = review.id;
    if (!created.reviewId) throw new Error("Failed to create review.");
    console.log("PASS review create");

    const deleteReviewResp = await callBackend(`/api/supabase/db/reviews/${encodeURIComponent(created.reviewId)}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!deleteReviewResp.ok && deleteReviewResp.status !== 204) {
      await expectJson(deleteReviewResp);
    }
    created.reviewId = null;
    console.log("PASS review delete");

    const adminAccessResp = await callBackend("/api/supabase/db/admin/plans", {
      headers: authHeaders,
    });
    if (adminAccessResp.status !== 403 && adminAccessResp.status !== 200) {
      const body = await adminAccessResp.text();
      throw new Error(`Unexpected admin endpoint status: ${adminAccessResp.status} ${body}`);
    }
    if (adminAccessResp.status === 403) {
      console.log("PASS admin protected (non-admin user)");
    } else {
      console.log("PASS admin access (admin user)");
    }

    console.log(`E2E critical flow completed for user ${userId}.`);
  } finally {
    if (created.reviewId) {
      await callBackend(`/api/supabase/db/reviews/${encodeURIComponent(created.reviewId)}`, {
        method: "DELETE",
        headers: authHeaders,
      }).catch(() => {});
    }
    if (created.listId) {
      await callBackend(`/api/supabase/db/user_lists/${encodeURIComponent(created.listId)}`, {
        method: "DELETE",
        headers: authHeaders,
      }).catch(() => {});
    }
  }
}

run().catch((error) => {
  console.error("E2E critical failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
