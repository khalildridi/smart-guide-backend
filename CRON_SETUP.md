# Cron Job Setup Guide

This document explains how to configure the daily AI recommendations update job.

## Overview

The backend provides an endpoint `/api/supabase/admin/update-ai-recommendations` that:
- Updates the `ai_recommended` flag for plans based on their score
- A plan is marked as "ai_recommended" if: `score >= 70 AND reviews_count >= 1`
- Can be called only with the correct `CRON_SECRET_KEY`

## Quick Start

### 1. Environment Setup

Ensure these variables are set in your `.env`:

```env
CRON_SECRET_KEY=your-secure-random-secret-key
BACKEND_URL=https://your-backend.com  # For remote deployments
```

Generate a secure key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Local Testing

Run the cron job manually:
```bash
npm run cron:update-ai
```

Expected output:
```
✅ Success: {
  success: true,
  message: 'AI recommendations updated successfully',
  timestamp: '2026-03-31T10:25:00.000Z',
  aiRecommendedCount: 12
}
```

## Deployment Options

### Option A: GitHub Actions (Recommended)

Create `.github/workflows/cron-ai-update.yml`:

```yaml
name: Update AI Recommendations

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:  # Manual trigger

jobs:
  update-ai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run AI recommendations update
        env:
          BACKEND_URL: ${{ secrets.BACKEND_URL }}
          CRON_SECRET_KEY: ${{ secrets.CRON_SECRET_KEY }}
        run: npm run cron:update-ai
```

### Option B: Render Cron Job (https://render.com)

If your backend is on Render:

1. Go to your backend service > **Cron Jobs**
2. Create a new cron job:
   - **Schedule**: `0 2 * * *` (daily at 2 AM UTC)
   - **Command**: `npm run cron:update-ai`
3. Set environment variables in your service settings

### Option C: EasyCron (https://www.easycron.com/)

1. Create a new cron job
2. **HTTP Request URL**: `https://your-backend.com/api/supabase/admin/update-ai-recommendations`
3. **Request Method**: POST
4. **Request Headers**:
   ```
   x-cron-secret: your-secret-key
   Content-Type: application/json
   ```
5. **Schedule**: Daily at 2 AM

### Option D: AWS Lambda + EventBridge

Create a Lambda function that calls `npm run cron:update-ai`, then:
1. Create an EventBridge rule with schedule `cron(0 2 * * ? *)`
2. Point it to the Lambda function

### Option E: Cloud Tasks (Google Cloud)

Set up a Cloud Task to POST to `/api/supabase/admin/update-ai-recommendations` with the secret header.

## Security Considerations

1. **Secret Key**: Use a strong, randomly generated secret key
2. **HTTPS Only**: Only accept requests over HTTPS in production
3. **Rate Limiting**: The endpoint is rate-limited like other API endpoints
4. **Logging**: All cron invocations are logged with timestamp and result

## Monitoring

Check backend logs for cron job execution:
```bash
# Look for logs containing [CRON]
docker logs your-backend-container | grep CRON
```

## Troubleshooting

### "CRON_SECRET_KEY not configured on server"
- Ensure `CRON_SECRET_KEY` is set in `.env` or deployment environment
- Restart the backend service

### "Invalid cron secret"
- Verify the secret key matches between:
  - Server `.env` or environment variable
  - Cron job request header (`x-cron-secret`)

### "Supabase not configured"
- Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set
- Verify backend has access to Supabase

### Network timeout
- If using local backend, ensure it's accessible from the cron service
- For remote backends, check firewall rules allow incoming POST requests
