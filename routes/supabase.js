const express = require('express');
const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SERVER_KEY = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;

const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const storageUpload = multer({ storage: multer.memoryStorage() });
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVER_KEY && createClient(SUPABASE_URL, SUPABASE_SERVER_KEY);
const supabaseServiceAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY && createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const DEBUG_ROUTES_ENABLED = process.env.DEBUG_ROUTES_ENABLED === 'true' || process.env.NODE_ENV !== 'production';

const PROXY_ALLOWED_TABLES = new Set(
  (process.env.PROXY_ALLOWED_TABLES ||
    'plans,reviews,profiles,user_badges,notifications')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);
const PROXY_AUTH_REQUIRED_TABLES = new Set(
  (process.env.PROXY_AUTH_REQUIRED_TABLES || 'notifications')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);

const FUNCTION_ALLOWED_NAMES = new Set(
  (process.env.FUNCTION_ALLOWED_NAMES || 'ai-recommendations,contact-form,notify-admin-report')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);

const RPC_RULES = {
  add_user_points: { authRequired: true, userScoped: true },
  delete_user_account: { authRequired: true, userScoped: true },
  get_admin_stats: { authRequired: true, userScoped: true },
  get_weekly_leaderboard: { authRequired: false, userScoped: false },
};

function extractRestTable(path) {
  const match = String(path || '').match(/^rest\/v1\/([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

router.get('/health', (req, res) => res.json({ supabase: !!SUPABASE_URL }));

router.post('/proxy', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVER_KEY)
    return res.status(500).json({ error: 'SUPABASE not configured' });
  if (typeof fetch !== 'function')
    return res
      .status(500)
      .json({ error: 'global fetch not available on this Node runtime' });

  const { path, method = 'GET', body, headers = {} } = req.body;
  if (!path) return res.status(400).json({ error: 'path required' });
  if (!/^rest\/v1\//.test(path)) return res.status(400).json({ error: 'Only rest/v1 paths are allowed' });
  if (path.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  if (String(method).toUpperCase() !== 'GET') return res.status(405).json({ error: 'Only GET is allowed on proxy' });

  const table = extractRestTable(path);
  if (!table || !PROXY_ALLOWED_TABLES.has(table)) {
    return res.status(403).json({ error: 'Table not allowed via proxy' });
  }

  const incomingAuth = req.headers.authorization;
  const userScopedRequest = typeof incomingAuth === 'string' && incomingAuth.startsWith('Bearer ');

  if (PROXY_AUTH_REQUIRED_TABLES.has(table)) {
    if (!userScopedRequest) return res.status(401).json({ error: `Authorization required for ${table}` });
    const accessToken = incomingAuth.split(' ')[1];
    const user = await verifyUser(accessToken);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  }

  const requestHeaders = Object.assign(
    {
      apikey: userScopedRequest ? (SUPABASE_ANON_KEY || SUPABASE_SERVER_KEY) : SUPABASE_SERVER_KEY,
      Authorization: userScopedRequest ? incomingAuth : `Bearer ${SUPABASE_SERVER_KEY}`,
      'Content-Type': 'application/json',
    },
    headers
  );

  try {
    const resp = await fetch(`${SUPABASE_URL}/${path}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      res.status(resp.status).send(text);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/debug/auth-mode', (req, res) => {
  if (!DEBUG_ROUTES_ENABLED) return res.status(404).json({ error: 'Not found' });
  const keySource = SUPABASE_SERVICE_KEY ? 'service' : (SUPABASE_ANON_KEY ? 'anon' : 'missing');
  res.json({
    supabaseConfigured: !!SUPABASE_URL,
    keySource,
    hasAnonKey: !!SUPABASE_ANON_KEY,
    hasServiceKey: !!SUPABASE_SERVICE_KEY,
  });
});

// Upload file to Supabase Storage via backend (requires auth)
router.post('/storage/upload', storageUpload.single('file'), async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!req.file) return res.status(400).json({ error: 'file required' });
  const bucket = req.body.bucket || 'plan-images';
  const ext = (req.file.originalname.split('.').pop() || 'bin').replace(/\W/g, '');
  const filename = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;

  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const { error: uploadError } = await supabaseAdmin.storage.from(bucket).upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message || String(uploadError) });

    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(filename);
    const publicUrl = data?.publicUrl || null;
    res.json({ path: filename, publicUrl });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Invoke Supabase Edge Function server-side using service key
router.post('/functions/invoke', async (req, res) => {
  const { name, body } = req.body;
  if (!name) return res.status(400).json({ error: 'function name required' });
  if (!FUNCTION_ALLOWED_NAMES.has(String(name))) {
    return res.status(403).json({ error: 'Function not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVER_KEY)
    return res.status(500).json({ error: 'SUPABASE not configured' });
  if (typeof fetch !== 'function')
    return res
      .status(500)
      .json({ error: 'global fetch not available on this Node runtime' });

  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      res.status(resp.status).send(text);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Helper: verify user from access token
async function verifyUser(accessToken) {
  if (!accessToken) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVER_KEY) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!resp.ok) {
      console.error('verifyUser: fetch not ok', resp.status);
      return null;
    }
    const data = await resp.json();
    const user = data.user || data.data?.user || data;
    console.log('verifyUser: success for', user.id || 'no-id');
    return user;
  } catch (err) {
    console.error('verifyUser: catch error', err);
    return null;
  }
}

async function isAdminUser(userId) {
  if (!userId) return false;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=is_admin`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    if (!resp.ok) return false;
    const rows = await resp.json();
    return Array.isArray(rows) && rows.length > 0 && rows[0].is_admin === true;
  } catch {
    return false;
  }
}

// Insert/update reviews (upsert by user_id,plan_id)
router.post('/db/reviews', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body;
  // enforce server-side user id for security
  payload.user_id = user.id;

  try {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?on_conflict=user_id,plan_id&select=*`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([payload]),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update review by id
router.patch('/db/reviews/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const body = req.body;

  try {
    // Ensure user owns the review
    const check = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await check.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete review
router.delete('/db/reviews/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  try {
    const check = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await check.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Increment helpful_count (protected: can't vote for own review)
router.post('/db/reviews/:id/helpful', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  try {
    const get = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await get.json();
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const review = rows[0];
    if (review.user_id === user.id) return res.status(403).json({ error: 'Cannot vote your own review' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ helpful_count: (review.helpful_count || 0) + 1 }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Favorites: check, insert, delete
router.get('/db/favorites', async (req, res) => {
  const { user_id, plan_id } = req.query;
  try {
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/favorites`);
    url.searchParams.set('select', '*');
    if (user_id) url.searchParams.set('user_id', `eq.${user_id}`);
    if (plan_id) url.searchParams.set('plan_id', `eq.${plan_id}`);
    const resp = await fetch(url.toString(), { headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` } });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/db/favorites', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const payload = Object.assign({}, req.body, { user_id: user.id });
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/favorites`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([payload]),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/db/favorites', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { plan_id } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/favorites?user_id=eq.${encodeURIComponent(user.id)}&plan_id=eq.${encodeURIComponent(plan_id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// User lists: list, create, delete (enforce user ownership server-side)
router.get('/db/user_lists', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/db/user_lists/counts', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/list_items?select=list_id,user_lists!inner(user_id)&user_lists.user_id=eq.${encodeURIComponent(user.id)}`;
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await resp.json();
    if (!Array.isArray(rows)) return res.status(resp.status).json(rows);

    const counts = rows.reduce((acc, row) => {
      const listId = row?.list_id;
      if (!listId) return acc;
      acc[listId] = (acc[listId] || 0) + 1;
      return acc;
    }, {});

    const data = Object.entries(counts).map(([list_id, item_count]) => ({ list_id, item_count }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/db/user_lists', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const payload = {
    user_id: user.id,
    name: req.body?.name,
    description: req.body?.description ?? null,
    icon: req.body?.icon || 'folder',
    color: req.body?.color || 'primary',
  };

  if (!payload.name || !String(payload.name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?select=*`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([payload]),
    });
    const data = await resp.json();
    res.status(resp.status).json(Array.isArray(data) ? data[0] : data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/db/user_lists/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  try {
    const check = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?id=eq.${encodeURIComponent(id)}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await check.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// List items: list by list_id, insert, delete, exists
router.get('/db/list_items', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { list_id, plan_id, with_plan } = req.query;
  if (!list_id) return res.status(400).json({ error: 'list_id required' });

  try {
    const own = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?id=eq.${encodeURIComponent(String(list_id))}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await own.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const select = with_plan === '1' ? '*,plans(*)' : '*';
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/list_items`);
    url.searchParams.set('select', select);
    url.searchParams.set('list_id', `eq.${String(list_id)}`);
    if (plan_id) url.searchParams.set('plan_id', `eq.${String(plan_id)}`);

    const resp = await fetch(url.toString(), {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/db/list_items', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { list_id, plan_id } = req.body;
  if (!list_id || !plan_id) return res.status(400).json({ error: 'list_id and plan_id required' });

  try {
    const own = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?id=eq.${encodeURIComponent(String(list_id))}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await own.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/list_items?select=*`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{ list_id, plan_id }]),
    });
    const data = await resp.json();
    res.status(resp.status).json(Array.isArray(data) ? data[0] : data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/db/list_items', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { list_id, plan_id } = req.body;
  if (!list_id || !plan_id) return res.status(400).json({ error: 'list_id and plan_id required' });

  try {
    const own = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?id=eq.${encodeURIComponent(String(list_id))}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await own.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/list_items?list_id=eq.${encodeURIComponent(String(list_id))}&plan_id=eq.${encodeURIComponent(String(plan_id))}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Content reports (insert)
router.post('/db/content_reports', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const payload = Object.assign({}, req.body, { reporter_id: user.id });
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/content_reports`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([payload]),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin: content reports
router.get('/db/admin/content_reports', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { status } = req.query;
  try {
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/content_reports`);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'created_at.desc');
    if (status && status !== 'all') url.searchParams.set('status', `eq.${status}`);

    const resp = await fetch(url.toString(), {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch('/db/admin/content_reports/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const patchBody = Object.assign({}, req.body, {
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
  });

  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/content_reports?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
    });
    const data = await resp.json();
    res.status(resp.status).json(Array.isArray(data) ? data[0] : data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin: reviews
router.get('/db/admin/reviews', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { search } = req.query;
  try {
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews`);
    url.searchParams.set('select', '*,profiles:user_id(display_name,avatar_url),plans:plan_id(name)');
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', '100');
    if (search) url.searchParams.set('comment', `ilike.*${String(search)}*`);

    const resp = await fetch(url.toString(), {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/db/admin/reviews/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin: plans
router.get('/db/admin/plans', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { search } = req.query;
  try {
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/plans`);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', '100');
    if (search) url.searchParams.set('name', `ilike.*${String(search)}*`);

    const resp = await fetch(url.toString(), {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/db/admin/plans/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/plans?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch('/db/admin/plans/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdminUser(user.id))) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/plans?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(Array.isArray(data) ? data[0] : data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update profile (display_name, avatar_url) - enforce user
router.patch('/db/profiles/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  console.log('PATCH /db/profiles/:id', { urlId: id, userId: user.id });
  const requesterIsAdmin = await isAdminUser(user.id);
  if (id !== user.id && !requesterIsAdmin) {
    console.warn('PATCH /db/profiles: forbidden mismatch', { urlId: id, userId: user.id });
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVER_KEY,
        Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Ensure profile exists for authenticated user (create if missing)
router.post('/db/profiles/ensure', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabaseServiceAdmin) {
    return res.status(500).json({
      error: 'Supabase service admin client not configured',
      hasServiceKey: !!SUPABASE_SERVICE_KEY,
    });
  }

  try {
    const userId = user.id;
    const { data: existing, error: existingError } = await supabaseServiceAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({
        error: 'Failed to read profile',
        details: existingError,
      });
    }

    if (existing) {
      return res.status(200).json(existing);
    }

    const meta = user.user_metadata || {};
    const displayName =
      meta.display_name ||
      meta.full_name ||
      meta.name ||
      (user.email ? user.email.split('@')[0] : null);
    const avatarUrl = meta.avatar_url || meta.picture || null;

    const payload = {
      id: userId,
      email: user.email || null,
      display_name: displayName,
      avatar_url: avatarUrl,
      points: 0,
      level: 'Bronze',
    };

    const { data: inserted, error: insertError } = await supabaseServiceAdmin
      .from('profiles')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();

    if (insertError) {
      return res.status(500).json({
        error: 'Failed to create profile',
        details: insertError,
      });
    }

    return res.status(200).json(inserted);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Notifications: mark single as read
router.patch('/db/notifications/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const check = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await check.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Notifications: mark all as read for authenticated user
router.post('/db/notifications/mark_all', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_read: true }),
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Notifications: delete
router.delete('/db/notifications/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const check = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    const rows = await check.json();
    if (!rows || rows.length === 0 || rows[0].user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` },
    });
    res.status(resp.status).send(await resp.text());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Create plan (enforce created_by)
router.post('/db/plans', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const payload = Object.assign({}, req.body, { created_by: user.id });
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/plans`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([payload]),
    });
    const data = await resp.json();
    res.status(resp.status).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Export user data (all user-related records)
router.get('/db/export-user-data', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userId = user.id;
    const [profile, reviews, favorites, lists, listItems, badges, plans, notifications, reports] = await Promise.all([
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?select=*&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/favorites?select=*,plans(name,category,location)&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_lists?select=*&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/list_items?select=*,user_lists!inner(user_id)&user_lists.user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_badges?select=*&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/plans?select=*&created_by=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?select=*&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
      fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/content_reports?select=*&reporter_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: SUPABASE_SERVER_KEY, Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }
      }).then(r => r.json()),
    ]);

    const exportData = {
      export_date: new Date().toISOString(),
      user_info: {
        email: user.email,
        created_at: user.created_at,
      },
      profile: Array.isArray(profile) && profile.length > 0 ? profile[0] : null,
      plans_created: Array.isArray(plans) ? plans : [],
      reviews: Array.isArray(reviews) ? reviews : [],
      favorites: Array.isArray(favorites) ? favorites : [],
      lists: Array.isArray(lists) ? lists : [],
      list_items: Array.isArray(listItems) ? listItems : [],
      badges: Array.isArray(badges) ? badges : [],
      notifications: Array.isArray(notifications) ? notifications : [],
      content_reports: Array.isArray(reports) ? reports : [],
    };

    res.set('Content-Disposition', `attachment; filename="smartplan-data-${userId}.json"`);
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Generic RPC forwarder (use service key)
router.post('/rpc/:name', async (req, res) => {
  const { name } = req.params;
  if (!name) return res.status(400).json({ error: 'RPC name required' });
  const rule = RPC_RULES[name];
  if (!rule) return res.status(403).json({ error: 'RPC not allowed' });

  const accessToken = req.headers.authorization?.split(' ')[1];
  let user = null;
  if (rule.authRequired) {
    user = await verifyUser(accessToken);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (name === 'add_user_points' && req.body?.user_id && user && req.body.user_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden: user_id mismatch' });
  }
  if (name === 'delete_user_account' && req.body?.target_user_id && user && req.body.target_user_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden: target_user_id mismatch' });
  }

  const apikey = rule.userScoped ? (SUPABASE_ANON_KEY || SUPABASE_SERVER_KEY) : SUPABASE_SERVER_KEY;
  const authorization = rule.userScoped && accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_SERVER_KEY}`;

  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        apikey,
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      res.status(resp.status).send(text);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

module.exports = router;
