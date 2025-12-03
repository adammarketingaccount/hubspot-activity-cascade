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

// Activity object type IDs (from HubSpot's expanded object support)
const ACTIVITY_TYPE_IDS = {
  "0-4": "notes",
  "0-48": "calls", 
  "0-49": "emails",
  "0-47": "meetings",
  "0-27": "tasks",
  "0-18": "communications" // SMS, WhatsApp, LinkedIn
};

const DEAL_TYPE_ID = "0-3";

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

  const signatureV3 = req.headers["x-hubspot-signature-v3"];
  const signatureV2 = req.headers["x-hubspot-signature-v2"];
  const signatureV1 = req.headers["x-hubspot-signature"];
  
  if (!signatureV3 && !signatureV2 && !signatureV1) {
    console.error("❌ Missing HubSpot signature header");
    return false;
  }

  if (!HUBSPOT_WEBHOOK_SECRET) {
    console.error("❌ HUBSPOT_WEBHOOK_SECRET not configured");
    return false;
  }

  try {
    // Try v3 signature (newest format)
    if (signatureV3) {
      const sourceString = HUBSPOT_WEBHOOK_SECRET + req.method + req.originalUrl + JSON.stringify(req.body);
      const hash = crypto.createHash("sha256").update(sourceString).digest("base64");
      
      if (hash === signatureV3) {
        return true;
      }
    }
    
    // Try v2 signature
    if (signatureV2) {
      const sourceString = HUBSPOT_WEBHOOK_SECRET + JSON.stringify(req.body);
      const hash = crypto.createHash("sha256").update(sourceString).digest("base64");
      
      if (hash === signatureV2) {
        return true;
      }
    }
    
    // Try v1 signature (legacy)
    if (signatureV1) {
      const sourceString = HUBSPOT_WEBHOOK_SECRET + JSON.stringify(req.body);
      const hash = crypto.createHash("sha256").update(sourceString).digest("hex");
      
      if (hash === signatureV1) {
        return true;
      }
    }
    
    console.error("❌ Invalid webhook signature");
    console.debug("Tried all signature versions");
    
    return false;
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
async function processActivityForDeal(activityId, dealId, activityType, eventId) {
  console.log(`\n🔄 Processing activity ${activityId} for deal: ${dealId} (event: ${eventId})`);
  
  const startTime = Date.now();
  const propertyType = await findPropertyObjectType();
  
  // Determine activity type from object type ID if not provided
  if (!activityType) {
    // Try to fetch the activity to determine its type
    activityType = "notes"; // Default fallback
  }

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

  // Get association type ID for this activity type to properties
  let assocTypeId;
  try {
    assocTypeId = await getAssociationTypeId(activityType, propertyType);
  } catch (e) {
    console.error(`❌ Could not get association type for ${activityType} → ${propertyType}: ${e.message}`);
    return {
      activityId: String(activityId),
      dealId: String(dealId),
      propertyCount: propertyIds.length,
      associationsAttempted: 0,
      reason: `Association type not found for ${activityType}`,
    };
  }

  let totalAssociationsCreated = 0;

  // Associate this specific activity with all properties
  for (const propId of propertyIds) {
    try {
      await associateActivityToProperty(activityType, activityId, propertyType, propId, assocTypeId);
      totalAssociationsCreated += 1;
      console.log(`  ✅ Associated ${activityType} ${activityId} → Property ${propId}`);
    } catch (err) {
      // If it already exists, HubSpot may error with 409; ignore duplicates
      const status = err?.response?.status;
      if (status === 409) {
        console.log(`  ⏭️  Already associated: ${activityType} ${activityId} → Property ${propId}`);
        continue; // Already associated, this is fine (idempotent)
      }
      // Log other errors but don't fail the entire operation
      console.error(`  ❌ Error associating ${activityType} ${activityId} to Property ${propId}:`, err.message);
    }
  }

  const duration = Date.now() - startTime;
  
  const result = {
    activityId: String(activityId),
    activityType,
    dealId: String(dealId),
    propertyCount: propertyIds.length,
    associationsCreated: totalAssociationsCreated,
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
      const { 
        objectId, 
        eventId, 
        subscriptionId, 
        subscriptionType,
        fromObjectId,
        toObjectId,
        fromObjectTypeId,
        toObjectTypeId,
        associationRemoved
      } = event;

      // Handle activity creation and association events
      const isActivityCreation = subscriptionType === "object.creation";
      const isActivityAssociation = subscriptionType === "object.associationChange";

      if (!isActivityCreation && !isActivityAssociation) {
        console.log(`⏭️  Skipping event: subscriptionType=${subscriptionType}`);
        continue;
      }

      let activityId = null;
      let dealId = null;
      let activityType = null;

      if (isActivityCreation) {
        // For creation events, we need to check if this activity is associated with any deals
        activityId = objectId;
        console.log(`📝 Activity created: ${activityId}`);
        // We'll process this by fetching all deals associated with this activity
        
      } else if (isActivityAssociation) {
        // Skip if association was removed
        if (associationRemoved) {
          console.log(`⏭️  Skipping: association removed`);
          continue;
        }

        // Determine if this is an activity-to-deal association
        const isActivityType = ACTIVITY_TYPE_IDS[fromObjectTypeId];
        const isDealType = toObjectTypeId === DEAL_TYPE_ID;

        if (isActivityType && isDealType) {
          activityId = fromObjectId;
          dealId = toObjectId;
          activityType = ACTIVITY_TYPE_IDS[fromObjectTypeId];
          console.log(`📌 Activity associated with deal: ${activityType} ${activityId} → Deal ${dealId}`);
        } else {
          console.log(`⏭️  Skipping: not activity-to-deal association (${fromObjectTypeId} → ${toObjectTypeId})`);
          continue;
        }
      }

      if (!activityId) {
        console.error("❌ Could not determine activity ID from event:", event);
        continue;
      }

      // Deduplication: Skip if we've already processed this event
      const dedupeKey = `${eventId || activityId}-${subscriptionId}-${dealId || 'creation'}`;
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
        // Small delay to ensure HubSpot has fully saved the associations
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // If we have a dealId, process just that deal
        // If not (creation event), fetch all deals associated with the activity
        if (dealId) {
          const result = await processActivityForDeal(activityId, dealId, activityType, eventId);
          results.push(result);
        } else {
          // For creation events, find all associated deals and process each
          const dealIds = await listAssociatedIds(activityType || "notes", activityId, "deals", 100);
          console.log(`🔍 Activity ${activityId} associated with ${dealIds.length} deals`);
          
          for (const dId of dealIds) {
            const result = await processActivityForDeal(activityId, dId, activityType, eventId);
            results.push(result);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing activity ${activityId}:`, error.message);
        console.error(error.stack);
        
        results.push({
          activityId,
          dealId,
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
    console.warn("⚠️  WARNING: HUBSPOT_PRIVATE_APP_TOKEN not set");
  }

  if (NODE_ENV === "production" && !HUBSPOT_WEBHOOK_SECRET) {
    console.warn("⚠️  WARNING: HUBSPOT_WEBHOOK_SECRET not set in production");
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
