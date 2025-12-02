# 🚀 Deployment Setup Guide

Complete step-by-step instructions for deploying the HubSpot Activity Association Service to Railway.

---

## 📋 Prerequisites

- [ ] HubSpot account with admin access
- [ ] Custom "Property" object configured in HubSpot
- [ ] Railway account ([sign up here](https://railway.app))
- [ ] Git repository for this code
- [ ] Node.js 18+ installed locally (for testing)

---

## Part 1: HubSpot Private App Setup

### Step 1: Create Private App

1. **Navigate to HubSpot Settings:**
   - Click the ⚙️ settings icon (top right)
   - Go to **Integrations** > **Private Apps**

2. **Create New Private App:**
   - Click **"Create a private app"**
   - **Basic Info:**
     - Name: `Activity Association Service`
     - Description: `Associates deal activities to related Property objects`

3. **Configure Scopes:**
   Click the **"Scopes"** tab and enable the following:

   **CRM Scopes:**
   - ✅ `crm.objects.deals.read` - Read deals
   - ✅ `crm.objects.deals.write` - Write deals (for associations)
   - ✅ `crm.objects.custom.read` - Read custom objects
   - ✅ `crm.objects.custom.write` - Write custom objects (for associations)
   - ✅ `crm.schemas.custom.read` - Read custom object schemas
   - ✅ `crm.objects.contacts.read` - Read contacts
   - ✅ `crm.objects.companies.read` - Read companies

   **Activity Object Scopes:**
   - ✅ `crm.objects.notes.read` - Read notes
   - ✅ `crm.objects.calls.read` - Read calls
   - ✅ `crm.objects.emails.read` - Read emails
   - ✅ `crm.objects.meetings.read` - Read meetings
   - ✅ `crm.objects.communications.read` - Read SMS/communications

4. **Create the App:**
   - Click **"Create app"**
   - Review the warning about access
   - Click **"Continue creating"**

5. **Copy the Access Token:**
   - Click **"Show token"**
   - **Copy and save this token securely** - you'll need it for Railway
   - Token format: `pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

⚠️ **Important:** Store this token securely. You can't view it again after closing the dialog.

---

## Part 2: Railway Deployment

### Step 1: Prepare Git Repository

1. **Initialize Git (if not already):**
   ```bash
   git init
   git add .
   git commit -m "Initial commit: HubSpot Activity Association Service"
   ```

2. **Push to GitHub/GitLab/Bitbucket:**
   ```bash
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

### Step 2: Deploy to Railway

1. **Create New Project:**
   - Go to [railway.app](https://railway.app)
   - Click **"New Project"**
   - Select **"Deploy from GitHub repo"**
   - Authorize Railway to access your repositories
   - Select your repository

2. **Configure Environment Variables:**
   - After deployment starts, click on your service
   - Go to **"Variables"** tab
   - Add the following variables:

   ```bash
   # Required
   HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-your-token-here
   HUBSPOT_WEBHOOK_SECRET=temporary-secret-will-update-later
   
   # Optional (can use defaults)
   PROPERTY_OBJECT_PLURAL_LABEL=Properties
   LOOKBACK_MS=600000
   MAX_ACTIVITY_IDS_PER_TYPE=50
   NODE_ENV=production
   ```

3. **Get Your Railway URL:**
   - Go to **"Settings"** tab
   - Under **"Domains"**, click **"Generate Domain"**
   - Copy the generated URL (e.g., `your-app.railway.app`)
   - **Save this URL** - you'll need it for webhook configuration

4. **Verify Deployment:**
   - Wait for deployment to complete (check **"Deployments"** tab)
   - Open your Railway URL in browser: `https://your-app.railway.app/health`
   - Should see: `{"status":"healthy",...}`

---

## Part 3: HubSpot Webhook Configuration

### Step 1: Create Webhook Subscription

1. **Navigate to Webhook Settings:**
   - HubSpot Settings > **Integrations** > **Private Apps**
   - Click on your **"Activity Association Service"** app
   - Click the **"Webhooks"** tab

2. **Configure Webhook:**
   - **Target URL:** `https://your-app.railway.app/webhook`
   - Click **"Create subscription"**

3. **Select Event Type:**
   - **Object:** `Deal`
   - **Event Type:** `Property Change`
   - Click **"Next"**

4. **Filter to Specific Property:**
   - Under **"Property filters"**, click **"Add filter"**
   - **Property name:** `hs_lastactivitydate` (Last activity date)
   - This ensures webhook only fires when activities are added
   - Click **"Next"**

5. **Copy Webhook Secret:**
   - After creating subscription, HubSpot shows a **webhook secret**
   - **Copy this secret immediately** - it's only shown once
   - Format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### Step 2: Update Railway with Webhook Secret

1. **Go back to Railway:**
   - Navigate to your project
   - Go to **"Variables"** tab
   - Update `HUBSPOT_WEBHOOK_SECRET` with the actual secret from HubSpot
   - Railway will automatically redeploy

2. **Wait for Redeploy:**
   - Check **"Deployments"** tab
   - Wait until status shows **"Success"**

---

## Part 4: Verify Configuration

### Step 1: Verify Custom Object Name

1. **Check Property Object Label:**
   - HubSpot Settings > **Data Management** > **Objects**
   - Find your custom **Property** object
   - Note the **plural label** (e.g., "Properties")
   - Ensure `PROPERTY_OBJECT_PLURAL_LABEL` in Railway matches exactly

### Step 2: Test the Webhook

1. **Create Test Activity:**
   - Go to any deal in HubSpot
   - Ensure deal has at least one associated Property
   - Add a note: "Test webhook integration"
   - Wait 5-10 seconds

2. **Check Railway Logs:**
   - Go to Railway > Your service > **"Logs"** tab
   - Look for:
     ```
     📨 Received 1 webhook event(s)
     🔄 Processing deal: 12345
     📋 Found X associated Properties
     ✅ Completed in XXXms
     ```

3. **Verify in HubSpot:**
   - Go to one of the associated Property objects
   - Check the **Activity** timeline
   - The test note should now appear

### Step 3: Common Issues

#### ❌ "Invalid signature" error
**Fix:** Ensure `HUBSPOT_WEBHOOK_SECRET` in Railway exactly matches the secret from HubSpot.

#### ❌ "No associated Properties found"
**Fix:** Ensure the test deal actually has Properties associated with it.

#### ❌ "Could not find custom object schema"
**Fix:** Update `PROPERTY_OBJECT_PLURAL_LABEL` to exactly match HubSpot (case-sensitive).

#### ❌ Webhook not firing
**Fix:** 
- Verify webhook subscription is active in HubSpot
- Check target URL is correct
- Ensure property filter is set to `hs_lastactivitydate`

---

## Part 5: Production Checklist

### Pre-Launch

- [ ] Private app created with all required scopes
- [ ] Access token saved securely
- [ ] Railway deployment successful
- [ ] Health endpoint responding (`/health`)
- [ ] Webhook subscription created and active
- [ ] Webhook secret configured in Railway
- [ ] Custom object plural label matches exactly
- [ ] Test webhook processed successfully
- [ ] Associations visible in HubSpot

### Post-Launch Monitoring

- [ ] Set up Railway monitoring/alerts
- [ ] Monitor Railway logs for errors
- [ ] Check HubSpot webhook delivery status
- [ ] Verify associations are created within 5-10 seconds
- [ ] Test with different activity types (note, call, email)

### Optional Enhancements

- [ ] Add Redis for deduplication cache (if high volume)
- [ ] Set up error alerting (e.g., email, Slack)
- [ ] Add request/response logging
- [ ] Implement rate limiting
- [ ] Add Datadog/New Relic monitoring
- [ ] Set up staging environment

---

## 📊 Monitoring & Maintenance

### Railway Dashboard

Monitor these metrics:
- **Deployments:** Ensure latest deployment is successful
- **Logs:** Watch for errors or warnings
- **Metrics:** CPU and memory usage
- **Health checks:** Should stay green

### HubSpot Webhook Dashboard

Check webhook delivery status:
- Settings > Integrations > Private Apps > [Your App] > Webhooks
- Click on your subscription
- View **delivery history** and success rate

### Expected Log Patterns

**Successful Processing:**
```
📨 Received 1 webhook event(s)
🔄 Processing deal: 12345 (event: 123456789)
✅ Found Property object type: p123456_property
📋 Found 3 associated Properties
⏰ Looking for activities since: 2025-12-02T10:20:00.000Z
  📝 Checking 5 notes...
  ✅ Found 1 recent notes in time window
✅ Completed in 1234ms
```

**Duplicate Event (Expected):**
```
⏭️ Skipping duplicate event: 123456789-987654
```

**No Properties (Expected for some deals):**
```
⚠️ No associated Properties found for deal 12345. Skipping.
```

---

## 🔧 Troubleshooting

### Issue: Activities not showing on Properties

**Diagnosis:**
1. Check Railway logs - was webhook received?
2. Did associations get attempted?
3. Check for errors in logs

**Solutions:**
- Increase `LOOKBACK_MS` if activities are older
- Verify activity types are enabled (e.g., `communications` for SMS)
- Check HubSpot API rate limits

### Issue: High error rate

**Diagnosis:**
- Check Railway logs for error messages
- Look at HubSpot webhook delivery failures

**Solutions:**
- Verify all required scopes are granted
- Check if custom object associations are properly configured in HubSpot
- Ensure network connectivity between Railway and HubSpot

### Issue: Slow processing

**Diagnosis:**
- Check processing duration in logs
- Monitor Railway CPU/memory usage

**Solutions:**
- Reduce `MAX_ACTIVITY_IDS_PER_TYPE`
- Reduce `LOOKBACK_MS` if not needed
- Consider upgrading Railway plan

---

## 🆘 Getting Help

### Support Resources

- **HubSpot API:** [developers.hubspot.com/docs](https://developers.hubspot.com/docs)
- **Railway Docs:** [docs.railway.app](https://docs.railway.app)
- **GitHub Issues:** Create an issue in your repository

### Debug Mode

Enable verbose logging temporarily:
1. Railway > Variables > Set `NODE_ENV=development`
2. Redeploy and check logs
3. Remember to set back to `production` after debugging

---

## 🎉 Success!

Once everything is working:
- Activities on deals automatically cascade to Properties
- Processing happens within 5-10 seconds
- No manual intervention needed
- System runs 24/7 on Railway

**Next Steps:**
- Monitor for a few days to ensure stability
- Document any custom configurations
- Share webhook URL with team (for troubleshooting)
