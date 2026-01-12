# HubSpot Activity Association Service

Automatically cascades activities (notes, calls, emails, meetings, tasks, communications) through your HubSpot object hierarchy: Contact → Deal → Property → Portfolio.

## 🎯 Purpose

When activities are logged in HubSpot, they **do not** automatically cascade to custom objects (Properties, Portfolios). This service provides complete activity cascade coverage through a **dual-architecture approach**:

### Webhook-Based Cascade (Real-time)
When activities are added to Deals, immediately cascade them to associated Properties.

### Polling-Based Cascade (Every 20 minutes)
Scan all activities and ensure they're associated with:
- **Portfolios** (via Property associations)
- **Deals** (via Property associations)

This handles the common workflow where users associate activities directly with Properties (bypassing Deals), ensuring those activities still appear on related Deals and Portfolios.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│ WEBHOOK-BASED (Real-time)                          │
├─────────────────────────────────────────────────────┤
│ Activity → Deal                                     │
│       ↓                                             │
│ Webhook fires (hs_lastactivitydate)                │
│       ↓                                             │
│ Fetch Deal's Properties                            │
│       ↓                                             │
│ Create Activity → Property associations            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ POLLING-BASED (Every 20 minutes)                   │
├─────────────────────────────────────────────────────┤
│ Fetch ALL activities (notes, calls, emails, etc.)  │
│       ↓                                             │
│ For each activity with Property associations:      │
│   • Find Property's Portfolios → Create Activity→Portfolio
│   • Find Property's Deals → Create Activity→Deal   │
│       ↓                                             │
│ Batch process with 3 concurrent batches            │
│ Performance: ~268 activities/sec                   │
└─────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- HubSpot account with custom Property object configured
- Railway account (or any Node.js hosting platform)

### Local Development

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your HubSpot credentials
   ```

3. **Run the server:**
   ```bash
   npm run dev
   ```

4. **Test the health endpoint:**
   ```bash
   curl http://localhost:3000/health
   ```

### Production Deployment

See [SETUP.md](./SETUP.md) for complete deployment instructions.

## 📋 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HUBSPOT_PRIVATE_APP_TOKEN` | Yes | Private app access token from HubSpot |
| `HUBSPOT_WEBHOOK_SECRET` | Yes (prod) | Webhook secret for signature verification |
| `PROPERTY_OBJECT_TYPE_ID` | Yes | Property custom object type ID (e.g., "2-160536042") |
| `PORTFOLIO_OBJECT_TYPE_ID` | Yes | Portfolio custom object type ID (e.g., "2-237039158") |
| `PROPERTY_OBJECT_PLURAL_LABEL` | No | Custom object plural label (default: "Properties") |
| `LOOKBACK_MS` | No | Time window for activities in ms (default: 600000 = 10 min) |
| `MAX_ACTIVITY_IDS_PER_TYPE` | No | Max activities to fetch per type (default: 50) |
| `NOTE_PORTFOLIO_SYNC_INTERVAL_MINUTES` | No | Polling interval (default: 20) |
| `PORT` | No | Server port (default: 3000, Railway sets automatically) |
| `NODE_ENV` | No | Environment mode (default: development) |

## 🔌 API Endpoints

### `GET /health`
Health check endpoint for monitoring.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-02T10:30:00.000Z",
  "uptime": 12345.67,
  "environment": "production"
}
```

### `POST /webhook`
Receives HubSpot webhook events.

**Expected payload:**
```json
[
  {
    "objectId": 12345,
    "propertyName": "hs_lastactivitydate",
    "propertyValue": "1701475200000",
    "eventId": 123456789,
    "subscriptionId": 987654,
    "occurredAt": 1701475200000
  }
]
```

**Response:**
```json
{
  "success": true,
  "processed": 1,
  "results": [
    {
      "dealId": "12345",
      "propertyCount": 3,
      "activitiesConsidered": 2,
      "associationsAttempted": 6,
      "durationMs": 1234
    }
  ]
}
```

## 🔧 Features

### Webhook-Based (Real-time)
- ✅ **Immediate response**: Triggers within seconds of activity creation
- ✅ **Deal → Property cascade**: Activities on Deals automatically appear on Properties
- ✅ **Signature verification**: Validates webhook authenticity
- ✅ **Deduplication**: Prevents processing the same event twice

### Polling-Based (Every 20 minutes)
- ✅ **Property → Portfolio cascade**: Activities on Properties appear on Portfolios
- ✅ **Property → Deal cascade**: Activities on Properties appear on Deals
- ✅ **All activity types**: notes, calls, emails, meetings, tasks, communications
- ✅ **Batch processing**: Processes 100 activities per batch with 3 concurrent batches
- ✅ **Performance**: ~268 activities/second average
- ✅ **Idempotent**: Safe to run multiple times, won't create duplicates

### General
- ✅ **Zero maintenance**: Runs continuously with retry logic and error handling
- ✅ **Time-window filtering**: Only processes recent activities (webhook mode)
- ✅ **Detailed logging**: Emoji indicators and performance metrics

## 🛠️ Technology Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **HTTP Client**: Axios
- **Hosting**: Railway (or any Node.js platform)
- **API**: HubSpot CRM API v3

## 📊 Monitoring

- **Health check endpoint**: `/health`
- **Webhook processing**: Real-time logs with deal IDs and property counts
- **Batch sync metrics**: Activities processed, associations created, duration
- **Console logs**: Emoji indicators for easy scanning (🔄 processing, ✅ success, ❌ error)
- **Performance tracking**: ~268 activities/second average throughput

## 🔍 How It Works

### Webhook Flow (Deal → Property)
1. Activity is associated with a Deal in HubSpot
2. `hs_lastactivitydate` changes, triggering webhook
3. Server receives webhook, validates signature
4. Fetches all recent activities for the Deal
5. Fetches all Properties associated with the Deal
6. Creates associations between activities and Properties

### Polling Flow (Property → Portfolio + Deal)
1. Every 20 minutes, fetch all activities of each type (notes, calls, emails, meetings, tasks, communications)
2. For each activity with Property associations:
   - Check which Portfolios those Properties belong to
   - Check which Deals those Properties belong to
   - Create missing Activity → Portfolio associations
   - Create missing Activity → Deal associations
3. Process in batches of 100 with 3 concurrent batches
4. Use HubSpot batch APIs to minimize API calls (100 associations per call)

## 🐛 Troubleshooting

### Webhook Issues

**Webhook not receiving events**
- Verify webhook URL in HubSpot matches your Railway deployment URL
- Check webhook subscription is active
- Verify `HUBSPOT_WEBHOOK_SECRET` matches HubSpot

**Invalid signature errors**
- Ensure `HUBSPOT_WEBHOOK_SECRET` is correct
- Check that webhook v3 signatures are enabled in HubSpot

**No activities found**
- Verify `LOOKBACK_MS` is long enough (default: 10 minutes)
- Check that activities are actually associated with the deal
- Increase the delay in the webhook handler if needed

### Polling Issues

**Associations not being created**
- Check Railway logs for errors during batch sync
- Verify `PROPERTY_OBJECT_TYPE_ID` and `PORTFOLIO_OBJECT_TYPE_ID` are correct
- Ensure activities have Property associations to cascade from
- Check HubSpot API rate limits aren't being exceeded

**Performance issues**
- Default processes ~268 activities/second
- Adjust `MAX_CONCURRENT_BATCHES` if hitting rate limits (currently 3)
- Monitor sync duration in logs (should complete in 5-10 minutes for all activity types)

### General

**Wrong custom object type**
- Verify `PROPERTY_OBJECT_PLURAL_LABEL` exactly matches HubSpot settings
- Check custom object IDs are correct (found in HubSpot object settings)

**Association type errors**
- Ensure proper association labels exist between activity types and custom objects
- System automatically detects HUBSPOT_DEFINED vs USER_DEFINED categories

## 📚 Documentation

- [GAMEPLAN.md](./GAMEPLAN.md) - Complete migration plan and architecture

## 💡 Why Two Systems?

**Webhooks** are ideal for Deal → Property cascade because:
- HubSpot fires webhooks when activities are added to Deals
- Real-time response (< 2 seconds)
- Minimal API usage

**Polling** is required for Property → Portfolio/Deal cascade because:
- HubSpot doesn't fire webhooks for activity → custom object associations
- Tested extensively (30+ audit log queries) - confirmed webhooks don't fire
- Handles the workflow where users associate activities directly with Properties
- Ensures comprehensive coverage across all object types

## 🎯 Use Cases

1. **Deal-centric workflow**: Activity added to Deal → appears on Properties → appears on Portfolio
2. **Property-centric workflow**: Activity added to Property → appears on Portfolio AND Deal
3. **Retroactive sync**: Existing activities are processed every 20 minutes
4. **Multi-object visibility**: One activity appears on Contact, Deal, Property, and Portfolio

## 📄 License

MIT
