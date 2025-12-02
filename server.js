const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 3000;
const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SECRET;
const PROPERTY_OBJECT_PLURAL_LABEL = process.env.PROPERTY_OBJECT_PLURAL_LABEL || "Properties";
const LOOKBACK_MS = parseInt(process.env.LOOKBACK_MS || "600000", 10); // 10 minutes default
const MAX_ACTIVITY_IDS_PER_TYPE = parseInt(process.env.MAX_ACTIVITY_IDS_PER_TYPE || "50", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Includes SMS logged as "communications" in many portals/integrations
const ACTIVITY_TYPES = ["notes", "calls", "emails", "meetings", "tasks", "communications"];

// Simple in-memory deduplication cache (for production, consider Redis)
const processedEvents = new Set();
const CACHE_MAX_SIZE = 10000;
const CACHE_CLEANUP_INTERVAL = 60000; // Clean up every minute

// ===== AXIOS INSTANCE =====
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` },
  timeout: 30000,
});

// ===== MIDDLEWARE =====
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ===== WEBHOOK SIGNATURE VERIFICATION =====
function verifyHubSpotSignature(req) {
  if (NODE_ENV === "development" && !HUBSPOT_WEBHOOK_SECRET) {
    console.warn("⚠️  WARNING: Skipping signature verification in development mode");
    return true;
  }

  const signature = req.headers["x-hubspot-signature-v3"] || req.headers["x-hubspot-signature"];
  
  if (!signature) {
    console.error("❌ Missing HubSpot signature header");
    return false;
  }

  if (!HUBSPOT_WEBHOOK_SECRET) {
    console.error("❌ HUBSPOT_WEBHOOK_SECRET not configured");
    return false;
  }

  try {
    // HubSpot v3 signature verification
    const sourceString = HUBSPOT_WEBHOOK_SECRET + JSON.stringify(req.body);
    const hash = crypto.createHash("sha256").update(sourceString).digest("hex");
    
    const isValid = hash === signature;
    
    if (!isValid) {
      console.error("❌ Invalid webhook signature");
      console.debug("Expected:", hash);
      console.debug("Received:", signature);
    }
    
    return isValid;
  } catch (error) {
    console.error("❌ Error verifying signature:", error.message);
    return false;
  }
}

// ===== HELPER FUNCTIONS =====
const parseHsDateMs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  // HubSpot datetime props usually come back as epoch-ms strings. Sometimes ISO.
  const asNum = Number(v);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(v);
  return Number.isFinite(asDate) ? asDate : null;
};

const getAllSchemas = async () => {
  const res = await hs.get("/crm-object-schemas/v3/schemas");
  return res.data?.results || res.data || [];
};

const findPropertyObjectType = async () => {
  const schemas = await getAllSchemas();
  const target = PROPERTY_OBJECT_PLURAL_LABEL.trim().toLowerCase();

  const schema =
    schemas.find((s) => String(s?.labels?.plural || "").trim().toLowerCase() === target) ||
    schemas.find((s) => String(s?.labels?.singular || "").trim().toLowerCase() === target) ||
    schemas.find((s) => String(s?.name || "").trim().toLowerCase() === target);

  if (!schema) {
    throw new Error(
      `Could not find a custom object schema with plural label "${PROPERTY_OBJECT_PLURAL_LABEL}". ` +
        `Update PROPERTY_OBJECT_PLURAL_LABEL in environment variables to match exactly.`
    );
  }

  if (!schema.fullyQualifiedName) {
    throw new Error("Found schema, but it has no fullyQualifiedName (unexpected).");
  }
  
  console.log(`✅ Found Property object type: ${schema.fullyQualifiedName}`);
  return schema.fullyQualifiedName;
};

const listAssociatedIds = async (fromType, fromId, toType, maxTotal = 500) => {
  const out = [];
  let after = undefined;

  while (out.length < maxTotal) {
    const params = { limit: Math.min(500, maxTotal - out.length) };
    if (after !== undefined) params.after = after;

    const res = await hs.get(
      `/crm/v3/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(
        toType
      )}`,
      { params }
    );

    const results = res.data?.results || [];
    for (const r of results) out.push(String(r.id));

    after = res.data?.paging?.next?.after;
    if (!after) break;
  }

  return out;
};

const getAssociationTypeId = async (fromType, toType) => {
  const res = await hs.get(
    `/crm/associations/v4/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`
  );

  const labels = res.data?.results || [];
  if (!labels.length) {
    throw new Error(`No association labels found between ${fromType} and ${toType}`);
  }

  // Prefer HUBSPOT_DEFINED if present
  const preferred = labels.find((l) => l.category === "HUBSPOT_DEFINED") || labels[0];
  return preferred.typeId;
};

const safeGetDealLastActivityMs = async (dealId) => {
  const res = await hs.get(`/crm/v3/objects/deals/${dealId}`, {
    params: { properties: "hs_lastactivitydate" },
  });

  return parseHsDateMs(res.data?.properties?.hs_lastactivitydate);
};

const batchReadActivities = async (type, ids) => {
  if (!ids.length) return [];
  
  const res = await hs.post(`/crm/v3/objects/${encodeURIComponent(type)}/batch/read`, {
    properties: ["hs_timestamp", "hs_createdate", "hs_lastmodifieddate"],
    inputs: ids.map((id) => ({ id })),
  });

  return res.data?.results || [];
};

const associateActivityToProperty = async (activityType, activityId, propertyType, propertyId, assocTypeId) => {
  const url =
    `/crm/v3/objects/${encodeURIComponent(activityType)}/${encodeURIComponent(activityId)}` +
    `/associations/${encodeURIComponent(propertyType)}/${encodeURIComponent(propertyId)}/${encodeURIComponent(assocTypeId)}`;

  // Force JSON so HubSpot doesn't reject with 415
  await hs.put(url, {}, { headers: { "Content-Type": "application/json" } });
};

// ===== CORE LOGIC =====
async function processActivityAssociation(dealId, eventId) {
  console.log(`\n🔄 Processing deal: ${dealId} (event: ${eventId})`);
  
  const startTime = Date.now();
  const propertyType = await findPropertyObjectType();

  // Get all Properties associated with this deal
  const propertyIds = await listAssociatedIds("deals", dealId, propertyType, 500);
  
  if (!propertyIds.length) {
    console.log(`⚠️  No associated Properties found for deal ${dealId}. Skipping.`);
    return {
      dealId: String(dealId),
      propertyCount: 0,
      activitiesConsidered: 0,
      associationsAttempted: 0,
      reason: "No associated Properties found on deal.",
    };
  }

  console.log(`📋 Found ${propertyIds.length} associated Properties`);

  // Get the deal's last activity date to determine time window
  const lastActivityMs = await safeGetDealLastActivityMs(dealId);
  const windowStart = (lastActivityMs ?? Date.now()) - LOOKBACK_MS;
  
  console.log(`⏰ Looking for activities since: ${new Date(windowStart).toISOString()}`);

  // Pre-fetch associationTypeId for each activity type -> property type
  const assocTypeIdByActivityType = {};
  for (const t of ACTIVITY_TYPES) {
    try {
      assocTypeIdByActivityType[t] = await getAssociationTypeId(t, propertyType);
    } catch (e) {
      // If your portal doesn't support a given activity object type, skip it
      console.warn(`⚠️  Could not get association type for ${t}: ${e.message}`);
      assocTypeIdByActivityType[t] = null;
    }
  }

  let totalAssociationsCreated = 0;
  const pickedActivities = [];

  for (const activityType of ACTIVITY_TYPES) {
    const assocTypeId = assocTypeIdByActivityType[activityType];
    if (!assocTypeId) continue;

    // Pull a slice of most recently-associated IDs we can see
    const activityIds = await listAssociatedIds("deals", dealId, activityType, MAX_ACTIVITY_IDS_PER_TYPE);
    if (!activityIds.length) continue;

    console.log(`  📝 Checking ${activityIds.length} ${activityType}...`);

    const records = await batchReadActivities(activityType, activityIds);

    // Keep activities in our time window
    const recent = records.filter((r) => {
      const p = r.properties || {};
      const t =
        parseHsDateMs(p.hs_timestamp) ||
        parseHsDateMs(p.hs_createdate) ||
        parseHsDateMs(p.hs_lastmodifieddate);

      return t !== null && t >= windowStart;
    });

    console.log(`  ✅ Found ${recent.length} recent ${activityType} in time window`);

    for (const r of recent) {
      pickedActivities.push({ type: activityType, id: String(r.id) });

      for (const propId of propertyIds) {
        try {
          await associateActivityToProperty(activityType, r.id, propertyType, propId, assocTypeId);
          totalAssociationsCreated += 1;
        } catch (err) {
          // If it already exists, HubSpot may error with 409; ignore duplicates
          const status = err?.response?.status;
          if (status === 409) {
            continue; // Already associated, this is fine (idempotent)
          }
          // Log other errors but don't fail the entire operation
          console.error(`  ❌ Error associating ${activityType} ${r.id} to Property ${propId}:`, err.message);
        }
      }
    }
  }

  const duration = Date.now() - startTime;
  
  const result = {
    dealId: String(dealId),
    propertyCount: propertyIds.length,
    activitiesConsidered: pickedActivities.length,
    associationsAttempted: totalAssociationsCreated,
    durationMs: duration,
  };

  console.log(`✅ Completed in ${duration}ms:`, result);
  
  return result;
}

// ===== ROUTES =====

// Health check endpoint for Railway
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
  });
});

// Main webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    // Verify webhook signature
    if (!verifyHubSpotSignature(req)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    // HubSpot sends webhooks as arrays
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    console.log(`\n📨 Received ${events.length} webhook event(s)`);

    const results = [];

    for (const event of events) {
      const { objectId, propertyName, eventId, subscriptionId } = event;

      // Only process deal.propertyChange for hs_lastactivitydate
      if (propertyName !== "hs_lastactivitydate") {
        console.log(`⏭️  Skipping event: propertyName=${propertyName} (not hs_lastactivitydate)`);
        continue;
      }

      if (!objectId) {
        console.error("❌ Event missing objectId:", event);
        continue;
      }

      // Deduplication: Skip if we've already processed this event
      const dedupeKey = `${eventId || objectId}-${subscriptionId}`;
      if (processedEvents.has(dedupeKey)) {
        console.log(`⏭️  Skipping duplicate event: ${dedupeKey}`);
        continue;
      }

      // Mark as processed
      processedEvents.add(dedupeKey);
      
      // Clean up cache if it gets too large
      if (processedEvents.size > CACHE_MAX_SIZE) {
        const toRemove = Array.from(processedEvents).slice(0, CACHE_MAX_SIZE / 2);
        toRemove.forEach(key => processedEvents.delete(key));
        console.log(`🧹 Cleaned up ${toRemove.length} old events from cache`);
      }

      try {
        // Small delay to ensure HubSpot has fully saved the activity
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const result = await processActivityAssociation(objectId, eventId);
        results.push(result);
      } catch (error) {
        console.error(`❌ Error processing deal ${objectId}:`, error.message);
        console.error(error.stack);
        
        results.push({
          dealId: objectId,
          error: error.message,
          success: false,
        });
      }
    }

    // Return 200 to acknowledge receipt (HubSpot will retry on non-2xx)
    res.json({
      success: true,
      processed: results.length,
      results,
    });

  } catch (error) {
    console.error("❌ Fatal error in webhook handler:", error.message);
    console.error(error.stack);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ===== STARTUP =====
function validateConfig() {
  const errors = [];

  if (!HUBSPOT_PRIVATE_APP_TOKEN) {
    errors.push("HUBSPOT_PRIVATE_APP_TOKEN is required");
  }

  if (NODE_ENV === "production" && !HUBSPOT_WEBHOOK_SECRET) {
    errors.push("HUBSPOT_WEBHOOK_SECRET is required in production");
  }

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }
}

// Periodic cache cleanup
setInterval(() => {
  const oldSize = processedEvents.size;
  if (oldSize > CACHE_MAX_SIZE) {
    const toRemove = Array.from(processedEvents).slice(0, CACHE_MAX_SIZE / 2);
    toRemove.forEach(key => processedEvents.delete(key));
    console.log(`🧹 Periodic cache cleanup: removed ${toRemove.length} old events`);
  }
}, CACHE_CLEANUP_INTERVAL);

validateConfig();

app.listen(PORT, () => {
  console.log("\n🚀 HubSpot Activity Association Service");
  console.log("=====================================");
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Port: ${PORT}`);
  console.log(`Property Object: ${PROPERTY_OBJECT_PLURAL_LABEL}`);
  console.log(`Lookback Window: ${LOOKBACK_MS}ms (${LOOKBACK_MS / 60000} minutes)`);
  console.log(`Webhook Secret: ${HUBSPOT_WEBHOOK_SECRET ? "✅ Configured" : "⚠️  Not configured"}`);
  console.log("=====================================\n");
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log("\n✅ Server ready to receive webhooks\n");
});
