# 🎯 Migration Game Plan: HubSpot Workflow → Railway-Hosted Solution

## Overview
Migrate custom code workflow that associates deal activities (notes, calls, emails, SMS) to related Property custom objects. Moving from HubSpot Operations Hub to self-hosted Railway solution due to loss of Data Professional tier.

---

## 📋 Problem Statement

**Current Situation:**
- Aircall logs calls to contacts
- HubSpot cascades these to associated deals ✅
- BUT does NOT cascade to deal's associated custom objects (Properties) ❌

**Original Solution:**
- Custom code workflow triggered on deal property changes
- Manually fetches recent activities and associates them to all related Properties

**Why Migration Needed:**
- No longer have Operations Hub Professional/Enterprise
- Need self-hosted alternative with same functionality

---

## 🏗️ Architecture Overview

### High-Level Flow
```
Activity Added to Deal
    ↓
hs_lastactivitydate property changes
    ↓
HubSpot Webhook fires → Railway Express Server
    ↓
Server fetches:
  - Deal's associated Properties (custom objects)
  - Recent activities from deal (within time window)
    ↓
Server creates associations:
  Activity → Property (for each property)
```

### Components

**1. Express.js Server**
- Webhook receiver endpoint (`POST /webhook`)
- HubSpot signature verification (security)
- Core association logic (adapted from workflow code)
- Health check endpoint (Railway monitoring)
- Error handling & logging

**2. Railway Deployment**
- Node.js environment
- Environment variable management
- Auto-deploy from Git
- Always-on server

**3. HubSpot Configuration**
- Private app with required scopes
- Webhook subscription to `deal.propertyChange` for `hs_lastactivitydate`
- Webhook endpoint URL pointing to Railway

---

## 🔑 Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Trigger Method** | Webhooks | Event-driven, immediate response |
| **Authentication** | Private App | Simpler than OAuth, no user context needed |
| **Processing Model** | Synchronous (initially) | Can add queue later if volume increases |
| **Deduplication** | In-memory cache | Prevent double-processing same event |
| **Error Handling** | Retry with backoff | Handle transient API failures |

---

## ⚠️ Important Considerations

### Webhook Payload Limitations
**⚠️ CRITICAL:** HubSpot webhook payloads likely do NOT include activity data directly.

**Expected Webhook Payload Structure:**
```json
[
  {
    "objectId": 12345,
    "propertyName": "hs_lastactivitydate",
    "propertyValue": "1701475200000",
    "changeSource": "CRM",
    "eventId": 123456789,
    "subscriptionId": 987654,
    "portalId": 12345678,
    "occurredAt": 1701475200000
  }
]
```

**What We Get:** Deal ID + timestamp of change  
**What We DON'T Get:** Activity details (type, ID, content)

**Solution:** After receiving webhook, server must:
1. Extract `dealId` from `objectId`
2. Fetch deal's `hs_lastactivitydate` to determine time window
3. **Query HubSpot API for recent activities** associated with the deal
4. Filter activities to those within the lookback window
5. Fetch associated Properties
6. Create associations between activities and Properties

This is similar to the original workflow code, which also fetched activities via API.

---

## 🔐 Required HubSpot Scopes

Private app must have these scopes:

```
✅ crm.objects.deals.read                 - Read deal data
✅ crm.objects.deals.write                - Create associations from activities to Properties
✅ crm.objects.custom.read                - Read Properties custom object
✅ crm.objects.custom.write               - Write associations to Properties
✅ crm.schemas.custom.read                - Find Property object type ID
✅ crm.objects.contacts.read              - Read contact data (activities may reference)
✅ crm.objects.companies.read             - Read company data
✅ crm.objects.notes.read                 - Read notes
✅ crm.objects.calls.read                 - Read calls
✅ crm.objects.emails.read                - Read emails
✅ crm.objects.meetings.read              - Read meetings
✅ crm.objects.communications.read        - Read SMS/communications
```

---

## 📝 Implementation Phases

### ✅ Phase 1: Architecture & Planning
- [x] Define webhook strategy
- [x] Document technical approach
- [x] Identify required scopes
- [x] Create game plan document

### 🔨 Phase 2: Server Development
- [ ] Create `server.js` with Express setup
- [ ] Implement webhook signature verification
- [ ] Adapt core logic from workflow code
- [ ] Add deduplication mechanism
- [ ] Implement error handling & logging
- [ ] Add health check endpoint

### 🚀 Phase 3: Deployment Configuration
- [ ] Create `package.json` with dependencies
- [ ] Create `railway.json` deployment config
- [ ] Create `.env.example` template
- [ ] Configure environment variables
- [ ] Set up Git repository (if not already)

### 🔧 Phase 4: HubSpot Configuration
- [ ] Create private app in HubSpot
- [ ] Configure required scopes
- [ ] Generate access token
- [ ] Create webhook subscription
- [ ] Configure webhook URL (Railway endpoint)

### 🧪 Phase 5: Testing & Validation
- [ ] Test webhook signature verification
- [ ] Test with sample webhook payload
- [ ] Validate activity fetching logic
- [ ] Verify association creation
- [ ] Test idempotency (run twice, same result)
- [ ] Monitor error logs

### 📊 Phase 6: Production Deployment
- [ ] Deploy to Railway
- [ ] Configure environment variables in Railway
- [ ] Update webhook URL in HubSpot
- [ ] Test with live data
- [ ] Set up monitoring/alerts
- [ ] Document troubleshooting steps

---

## 🔄 Workflow Comparison

### Original Workflow Code
```javascript
// Triggered by: Workflow enrollment condition
// Input: event.object.objectId (deal ID)
// Output: callback() with statistics
// Execution: HubSpot manages
```

### Railway Solution
```javascript
// Triggered by: Webhook POST request
// Input: req.body[0].objectId (deal ID from webhook)
// Output: HTTP 200 response
// Execution: Self-managed Express server
```

**Key Differences:**
1. **Trigger**: Workflow conditions → Webhook events
2. **Input Format**: Single event object → Array of events
3. **Output**: Callback function → HTTP response
4. **Secrets**: HubSpot secrets manager → Environment variables
5. **Execution**: HubSpot platform → Railway server
6. **Monitoring**: Workflow logs → Server logs + Railway metrics

---

## 🛠️ Files to Create

1. **`server.js`** - Main Express server with webhook endpoint and logic
2. **`package.json`** - Node.js dependencies and scripts
3. **`railway.json`** - Railway-specific deployment configuration
4. **`.env.example`** - Template for environment variables
5. **`.gitignore`** - Exclude node_modules, .env, etc.
6. **`SETUP.md`** - Step-by-step setup instructions
7. **`README.md`** - Project overview and documentation

---

## 🎛️ Environment Variables

```bash
# HubSpot Authentication
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-...

# Webhook Security
HUBSPOT_WEBHOOK_SECRET=your-webhook-secret

# Configuration
PROPERTY_OBJECT_PLURAL_LABEL=Properties
LOOKBACK_MS=600000  # 10 minutes in milliseconds
MAX_ACTIVITY_IDS_PER_TYPE=50

# Server
PORT=3000
NODE_ENV=production
```

---

## 📊 Success Metrics

**How to verify it's working:**
1. ✅ Webhook receives events when activities added to deals
2. ✅ Server successfully fetches associated Properties
3. ✅ Associations created between activities and Properties
4. ✅ Idempotent (running twice doesn't create duplicates)
5. ✅ Error handling prevents crashes
6. ✅ Logs provide visibility into operations

**Expected Behavior:**
- When note/call/email/SMS added to deal → webhook fires within seconds
- Server processes in < 5 seconds for typical case (1-5 properties)
- Activities appear on Property object timelines in HubSpot
- No duplicate associations created

---

## 🚨 Potential Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Webhook signature invalid | Wrong secret or verification logic | Verify secret matches HubSpot, check signature algorithm |
| No activities found | Timing issue, webhook fires before activity saved | Add small delay (1-2s) before fetching activities |
| 429 Rate limit errors | Too many API calls | Implement rate limiting, add delays between calls |
| 409 Conflict on association | Association already exists | Catch 409 errors, treat as success (idempotent) |
| Webhook fires multiple times | HubSpot retry mechanism | Use deduplication with eventId |
| Wrong custom object type | Mismatch in plural label | Verify exact label in HubSpot settings |

---

## 🔍 Testing Strategy

### Local Testing
1. Use ngrok or similar to expose local server
2. Configure webhook to point to ngrok URL
3. Add test activity to deal in HubSpot
4. Verify webhook received and processed
5. Check logs for errors

### Production Testing
1. Deploy to Railway staging environment first
2. Test with non-critical deal
3. Verify associations created correctly
4. Monitor error rates
5. Gradually roll out to all deals

---

## 📚 Resources

- [HubSpot Webhooks Documentation](https://developers.hubspot.com/docs/api/webhooks)
- [HubSpot Private Apps](https://developers.hubspot.com/docs/api/private-apps)
- [HubSpot CRM API](https://developers.hubspot.com/docs/api/crm/understanding-the-crm)
- [Railway Documentation](https://docs.railway.app/)
- [Express.js Guide](https://expressjs.com/)

---

## 🎯 Next Steps

1. ✅ Review and approve game plan
2. 🔨 Begin Phase 2: Server Development
3. 🚀 Continue through phases sequentially
4. 📊 Monitor and iterate after deployment

---

**Last Updated:** December 2, 2025  
**Status:** Planning Complete - Ready for Implementation
