# Quick Reference: Deploy to Railway

## 🚀 Railway Deployment Steps

### 1. Create Railway Project
- Go to https://railway.app
- Click "New Project"
- Select "Deploy from GitHub repo"
- Authorize Railway to access your repositories
- Select your repository (e.g., `hubspot-activity-cascade`)

### 2. Environment Variables to Set in Railway

Copy these into Railway's Variables tab:

```bash
HUBSPOT_PRIVATE_APP_TOKEN=<paste-your-token-here>
HUBSPOT_WEBHOOK_SECRET=temporary-will-update-later
PROPERTY_OBJECT_PLURAL_LABEL=Properties
LOOKBACK_MS=600000
MAX_ACTIVITY_IDS_PER_TYPE=50
NODE_ENV=production
```

### 3. Generate Railway Domain
- Go to Settings tab
- Under "Domains", click "Generate Domain"
- Copy the URL (e.g., `your-app.railway.app`)
- Save it for webhook configuration

### 4. Verify Deployment
- Check Deployments tab for "Success" status
- Visit: `https://your-app.railway.app/health`
- Should see: `{"status":"healthy",...}`

### 5. Configure HubSpot Webhook
- HubSpot Settings → Integrations → Private Apps
- Click your app → Webhooks tab
- Create subscription:
  - Target URL: `https://your-app.railway.app/webhook`
  - Object: Deal
  - Event: Property Change
  - Filter: Property name = `hs_lastactivitydate`
- Copy the webhook secret shown

### 6. Update Railway with Webhook Secret
- Go back to Railway → Variables
- Update `HUBSPOT_WEBHOOK_SECRET` with the real secret
- Railway will auto-redeploy

### 7. Test End-to-End
- Add a note to a deal with associated Properties
- Check Railway logs for processing confirmation
- Verify note appears on Property timelines

---

## 📝 Your Private App Token

When you get your token from HubSpot, add it to `.env`:

```bash
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Then you can test locally with:
```bash
npm run dev
```

---

## ✅ Checklist

- [x] Dependencies installed (`npm install`)
- [x] Git repository initialized
- [x] Initial commit created
- [ ] Private app created in HubSpot
- [ ] Token added to `.env` file
- [ ] Local test (`npm run dev`)
- [ ] Code pushed to GitHub
- [ ] Railway project created
- [ ] Environment variables set in Railway
- [ ] Railway domain generated
- [ ] Webhook configured in HubSpot
- [ ] Webhook secret updated in Railway
- [ ] End-to-end test completed

---

## 🆘 Need Help?

See `SETUP.md` for detailed step-by-step instructions.
