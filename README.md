# HubSpot Activity Association Service

Automatically associates deal activities (notes, calls, emails, SMS) to related Property custom objects in HubSpot.

## 🎯 Purpose

When activities are logged to contacts and cascade to deals via HubSpot's native settings, they **do not** automatically cascade to the deal's associated custom objects (Properties). This service bridges that gap by:

1. Listening for webhook events when activities are added to deals
2. Fetching all Properties associated with the deal
3. Creating associations between the activities and all related Properties

## 🏗️ Architecture

```
Activity Added to Deal
    ↓
hs_lastactivitydate changes
    ↓
HubSpot Webhook → Railway Server
    ↓
Fetch associated Properties
    ↓
Associate activities to Properties
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
| `PROPERTY_OBJECT_PLURAL_LABEL` | No | Custom object plural label (default: "Properties") |
| `LOOKBACK_MS` | No | Time window for activities in ms (default: 600000 = 10 min) |
| `MAX_ACTIVITY_IDS_PER_TYPE` | No | Max activities to fetch per type (default: 50) |
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

- ✅ **Webhook-driven**: Responds immediately when activities are added
- ✅ **Idempotent**: Safe to run multiple times, won't create duplicates
- ✅ **Signature verification**: Validates webhook authenticity
- ✅ **Deduplication**: Prevents processing the same event twice
- ✅ **Multiple activity types**: Handles notes, calls, emails, meetings, tasks, SMS
- ✅ **Time-window filtering**: Only processes recent activities
- ✅ **Error handling**: Gracefully handles API failures
- ✅ **Logging**: Detailed console logging for debugging

## 🛠️ Technology Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **HTTP Client**: Axios
- **Hosting**: Railway (or any Node.js platform)
- **API**: HubSpot CRM API v3

## 📊 Monitoring

- Health check endpoint: `/health`
- Console logs with emoji indicators for easy scanning
- Process duration tracking
- Error logging with stack traces

## 🐛 Troubleshooting

### Webhook not receiving events
- Verify webhook URL in HubSpot matches your Railway deployment URL
- Check webhook subscription is active
- Verify `HUBSPOT_WEBHOOK_SECRET` matches HubSpot

### Invalid signature errors
- Ensure `HUBSPOT_WEBHOOK_SECRET` is correct
- Check that webhook v3 signatures are enabled in HubSpot

### No activities found
- Verify `LOOKBACK_MS` is long enough
- Check that activities are actually associated with the deal
- Increase the delay in the webhook handler (currently 1.5s)

### Wrong custom object type
- Verify `PROPERTY_OBJECT_PLURAL_LABEL` exactly matches HubSpot settings
- Check custom object is properly configured

## 📚 Documentation

- [GAMEPLAN.md](./GAMEPLAN.md) - Complete migration plan and architecture
- [SETUP.md](./SETUP.md) - Step-by-step deployment guide (coming soon)

## 📄 License

MIT
