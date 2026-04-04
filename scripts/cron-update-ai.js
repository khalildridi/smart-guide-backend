#!/usr/bin/env node

/**
 * Cron job script: Update AI recommendations
 * 
 * This script triggers the backend endpoint to update AI recommendations.
 * It's designed to be called periodically (e.g., daily via cron, GitHub Actions, or Render cron).
 * 
 * Usage:
 *   npm run cron:update-ai
 *   
 * Environment variables required:
 *   - BACKEND_URL: Base URL of the backend (default: http://localhost:4000)
 *   - CRON_SECRET_KEY: Secret key to authenticate the cron request
 */

const BASE_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const CRON_SECRET_KEY = process.env.CRON_SECRET_KEY;

async function runCron() {
  if (!CRON_SECRET_KEY) {
    console.error('❌ Error: CRON_SECRET_KEY environment variable is not set');
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Starting AI recommendations update cron job...`);
  console.log(`Backend URL: ${BASE_URL}`);

  try {
    const response = await fetch(`${BASE_URL}/api/supabase/admin/update-ai-recommendations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': CRON_SECRET_KEY,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`❌ Error (HTTP ${response.status}):`, data);
      process.exit(1);
    }

    console.log('✅ Success:', data);
    console.log(`[${new Date().toISOString()}] AI recommendations update completed.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

runCron();
