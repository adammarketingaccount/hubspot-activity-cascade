const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 3000;
const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SECRET;
const PROPERTY_OBJECT_PLURAL_LABEL = process.env.PROPERTY_OBJECT_PLURAL_LABEL || "Properties";
const PROPERTY_OBJECT_TYPE_ID = process.env.PROPERTY_OBJECT_TYPE_ID;
const PORTFOLIO_OBJECT_TYPE_ID = process.env.PORTFOLIO_OBJECT_TYPE_ID;
const POLLING_INTERVAL_MINUTES = parseInt(process.env.POLLING_INTERVAL_MINUTES || "5", 10);
const POLLING_LOOKBACK_MINUTES = parseInt(process.env.POLLING_LOOKBACK_MINUTES || "10", 10);
const LOOKBACK_MS = parseInt(process.env.LOOKBACK_MS || "600000", 10); // 10 minutes default
const MAX_ACTIVITY_IDS_PER_TYPE = parseInt(process.env.MAX_ACTIVITY_IDS_PER_TYPE || "50", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Activity object type IDs (from HubSpot's expanded object support)
const ACTIVITY_TYPE_IDS = {
  "0-4": "notes",
  "0-46": "notes", // Alternative note type ID
  "0-48": "calls", 
  "0-49": "emails",
  "0-47": "meetings",
  "0-27": "tasks",
  "0-18": "communications" // SMS, WhatsApp, LinkedIn
};

const DEAL_TYPE_ID = "0-3";

// Store the fullyQualifiedNames for custom objects (fetched at startup)
let propertyObjectName = null;
let portfolioObjectName = null;

// Note→Portfolio sync configuration
const NOTE_PORTFOLIO_SYNC_INTERVAL_MINUTES = parseInt(process.env.NOTE_PORTFOLIO_SYNC_INTERVAL_MINUTES || "20", 10);
const BATCH_SIZE = 100;
const MAX_CONCURRENT_BATCHES = 3;

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

const findObjectTypeByTypeId = async (objectTypeId, objectName) => {
  const schemas = await getAllSchemas();
  const schema = schemas.find((s) => s.objectTypeId === objectTypeId);

  if (!schema) {
    throw new Error(
      `Could not find object schema with objectTypeId "${objectTypeId}" for ${objectName}.`
    );
  }

  if (!schema.fullyQualifiedName) {
    throw new Error(`Found ${objectName} schema, but it has no fullyQualifiedName (unexpected).`);
  }
  
  console.log(`✅ Found ${objectName} object type: ${schema.fullyQualifiedName} (ID: ${objectTypeId})`);
  return schema.fullyQualifiedName;
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

async function processActivityForProperty(activityId, propertyId, activityType, eventId) {
  console.log(`\n🔄 Processing activity ${activityId} for property: ${propertyId} (event: ${eventId})`);
  
  const startTime = Date.now();
  
  // Use cached portfolio object name
  if (!portfolioObjectName) {
    throw new Error("Portfolio object name not initialized");
  }
  
  // Determine activity type from object type ID if not provided
  if (!activityType) {
    activityType = "notes"; // Default fallback
  }

  // Get all Portfolios associated with this Property
  const portfolioIds = await listAssociatedIds(propertyObjectName, propertyId, portfolioObjectName, 500);
  
  if (!portfolioIds.length) {
    console.log(`⚠️  No associated Portfolios found for property ${propertyId}. Skipping.`);
    return {
      propertyId: String(propertyId),
      portfolioCount: 0,
      associationsAttempted: 0,
      reason: "No associated Portfolios found on property.",
    };
  }

  console.log(`📋 Found ${portfolioIds.length} associated Portfolios`);

  // Get association type ID for this activity type to portfolios
  let assocTypeId;
  try {
    assocTypeId = await getAssociationTypeId(activityType, portfolioObjectName);
  } catch (e) {
    console.error(`❌ Could not get association type for ${activityType} → ${portfolioObjectName}: ${e.message}`);
    return {
      activityId: String(activityId),
      propertyId: String(propertyId),
      portfolioCount: portfolioIds.length,
      associationsAttempted: 0,
      reason: `Association type not found for ${activityType}`,
    };
  }

  let totalAssociationsCreated = 0;

  // Associate this specific activity with all portfolios
  for (const portfolioId of portfolioIds) {
    try {
      await associateActivityToProperty(activityType, activityId, portfolioObjectName, portfolioId, assocTypeId);
      totalAssociationsCreated += 1;
      console.log(`  ✅ Associated ${activityType} ${activityId} → Portfolio ${portfolioId}`);
    } catch (err) {
      // If it already exists, HubSpot may error with 409; ignore duplicates
      const status = err?.response?.status;
      if (status === 409) {
        console.log(`  ⏭️  Already associated: ${activityType} ${activityId} → Portfolio ${portfolioId}`);
        continue; // Already associated, this is fine (idempotent)
      }
      // Log other errors but don't fail the entire operation
      console.error(`  ❌ Error associating ${activityType} ${activityId} to Portfolio ${portfolioId}:`, err.message);
    }
  }

  const duration = Date.now() - startTime;
  
  const result = {
    activityId: String(activityId),
    activityType,
    propertyId: String(propertyId),
    portfolioCount: portfolioIds.length,
    associationsCreated: totalAssociationsCreated,
    durationMs: duration,
  };

  console.log(`✅ Completed in ${duration}ms:`, result);
  
  return result;
}

// ===== POLLING LOGIC =====
async function pollPropertyAssociations() {
  try {
    console.log(`\n🔍 Polling for Property association changes...`);
    
    // Calculate lookback timestamp
    const lookbackMs = POLLING_LOOKBACK_MINUTES * 60 * 1000;
    const occurredAfter = new Date(Date.now() - lookbackMs).toISOString();
    
    // Query audit logs for Property association events
    const response = await hs.get('/account-info/v3/activity/audit-logs', {
      params: {
        occurredAfter,
        limit: 100
      }
    });
    
    const events = response.data?.results || [];
    
    // Filter for Property association CREATE events
    const propertyAssociationEvents = events.filter(event => 
      event.category === 'CRM_OBJECT_ASSOCIATION' &&
      event.subCategory === `p342639672_properties` &&
      event.action === 'CREATE'
    );
    
    if (propertyAssociationEvents.length === 0) {
      console.log(`✅ No new Property associations found`);
      return;
    }
    
    console.log(`📋 Found ${propertyAssociationEvents.length} Property association events`);
    
    // Get unique Property IDs
    const propertyIds = [...new Set(propertyAssociationEvents.map(e => e.targetObjectId))];
    console.log(`📌 Processing ${propertyIds.length} unique Properties`);
    
    let totalProcessed = 0;
    
    // For each Property, get all activities and cascade to Portfolios
    for (const propertyId of propertyIds) {
      try {
        // Get all activity associations for this Property
        const activityTypes = ['notes', 'calls', 'emails', 'communications'];
        
        for (const activityType of activityTypes) {
          try {
            const activityIds = await listAssociatedIds(propertyObjectName, propertyId, activityType, 100);
            
            if (activityIds.length === 0) continue;
            
            console.log(`  📝 Property ${propertyId} has ${activityIds.length} ${activityType}`);
            
            // Process each activity
            for (const activityId of activityIds) {
              const result = await processActivityForProperty(activityId, propertyId, activityType, `poll-${Date.now()}`);
              if (result.associationsCreated > 0) {
                totalProcessed++;
              }
            }
          } catch (err) {
            console.error(`  ❌ Error processing ${activityType} for Property ${propertyId}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`❌ Error processing Property ${propertyId}:`, err.message);
      }
    }
    
    console.log(`✅ Polling complete: ${totalProcessed} activities cascaded to Portfolios\n`);
    
  } catch (error) {
    console.error(`❌ Error in polling:`, error.message);
    if (error.response?.status === 401) {
      console.error(`⚠️  Authentication failed - check HUBSPOT_PRIVATE_APP_TOKEN and account-info.security.read scope`);
    }
  }
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
        objectTypeId,
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
        // Log the full event for debugging non-object events
        if (subscriptionType && subscriptionType.includes('deal')) {
          console.log(`📋 Deal event details:`, JSON.stringify(event, null, 2));
        }
        continue;
      }

      let activityId = null;
      let dealId = null;
      let propertyId = null;
      let activityType = null;

      if (isActivityCreation) {
        // For creation events, determine activity type from objectTypeId
        activityId = objectId;
        activityType = ACTIVITY_TYPE_IDS[objectTypeId];
        
        if (!activityType) {
          console.log(`⏭️  Skipping: unknown object type ${objectTypeId}`);
          continue;
        }
        
        console.log(`📝 Activity created: ${activityType} ${activityId} (objectTypeId=${objectTypeId})`);
        // We'll process this by fetching all deals associated with this activity
        
      } else if (isActivityAssociation) {
        // Skip if association was removed
        if (associationRemoved) {
          console.log(`⏭️  Skipping: association removed`);
          continue;
        }

        // Determine what type of association this is
        const isActivityFromType = ACTIVITY_TYPE_IDS[fromObjectTypeId];
        const isActivityToType = ACTIVITY_TYPE_IDS[toObjectTypeId];
        const isDealFromType = fromObjectTypeId === DEAL_TYPE_ID;
        const isDealToType = toObjectTypeId === DEAL_TYPE_ID;
        const isPropertyFromType = fromObjectTypeId === PROPERTY_OBJECT_TYPE_ID;
        const isPropertyToType = toObjectTypeId === PROPERTY_OBJECT_TYPE_ID;

        if (isActivityFromType && isDealToType) {
          // Activity → Deal: cascade to Properties
          activityId = fromObjectId;
          dealId = toObjectId;
          activityType = ACTIVITY_TYPE_IDS[fromObjectTypeId];
          console.log(`📌 Activity associated with deal: ${activityType} ${activityId} → Deal ${dealId}`);
        } else if (isDealFromType && isActivityToType) {
          // Deal → Activity (reverse): cascade to Properties
          activityId = toObjectId;
          dealId = fromObjectId;
          activityType = ACTIVITY_TYPE_IDS[toObjectTypeId];
          console.log(`📌 Activity associated with deal (reverse): ${activityType} ${activityId} → Deal ${dealId}`);
        } else if (isActivityFromType && isPropertyToType) {
          // Activity → Property: cascade to Portfolios
          activityId = fromObjectId;
          propertyId = toObjectId;
          activityType = ACTIVITY_TYPE_IDS[fromObjectTypeId];
          console.log(`📌 Activity associated with property: ${activityType} ${activityId} → Property ${propertyId}`);
        } else if (isPropertyFromType && isActivityToType) {
          // Property → Activity (reverse): cascade to Portfolios
          activityId = toObjectId;
          propertyId = fromObjectId;
          activityType = ACTIVITY_TYPE_IDS[toObjectTypeId];
          console.log(`📌 Activity associated with property (reverse): ${activityType} ${activityId} → Property ${propertyId}`);
        } else {
          console.log(`⏭️  Skipping: not activity-to-deal or activity-to-property association (${fromObjectTypeId} → ${toObjectTypeId})`);
          continue;
        }
      }

      if (!activityId) {
        console.error("❌ Could not determine activity ID from event:", event);
        continue;
      }

      // Deduplication: Skip if we've already processed this event
      const dedupeKey = `${eventId || activityId}-${subscriptionId}-${dealId || propertyId || 'creation'}`;
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
        
        // Determine which cascade to perform
        if (propertyId) {
          // Activity → Property: cascade to Portfolios
          const result = await processActivityForProperty(activityId, propertyId, activityType, eventId);
          results.push(result);
        } else if (dealId) {
          // Activity → Deal: cascade to Properties
          const result = await processActivityForDeal(activityId, dealId, activityType, eventId);
          results.push(result);
        } else {
          // For creation events, check for both Deal and Property associations
          if (!activityType) {
            console.error(`❌ Cannot fetch associations without activityType for activity ${activityId}`);
            continue;
          }
          
          // Check for Deal associations
          const dealIds = await listAssociatedIds(activityType, activityId, "deals", 100);
          console.log(`🔍 Activity ${activityId} associated with ${dealIds.length} deals`);
          
          for (const dId of dealIds) {
            const result = await processActivityForDeal(activityId, dId, activityType, eventId);
            results.push(result);
          }
          
          // Check for Property associations (custom objects don't trigger association webhooks)
          let propertyIds = [];
          if (propertyObjectName) {
            propertyIds = await listAssociatedIds(activityType, activityId, propertyObjectName, 100);
            console.log(`🔍 Activity ${activityId} associated with ${propertyIds.length} properties`);
            
            for (const pId of propertyIds) {
              const result = await processActivityForProperty(activityId, pId, activityType, eventId);
              results.push(result);
            }
          }
          
          if (dealIds.length === 0 && propertyIds.length === 0) {
            console.log(`⚠️  No associations found for ${activityType} ${activityId}`);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing activity ${activityId}:`, error.message);
        console.error(error.stack);
        
        results.push({
          activityId,
          dealId,
          propertyId,
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

  if (!PROPERTY_OBJECT_TYPE_ID) {
    errors.push("PROPERTY_OBJECT_TYPE_ID must be set (e.g., 2-160536042)");
  }

  if (!PORTFOLIO_OBJECT_TYPE_ID) {
    errors.push("PORTFOLIO_OBJECT_TYPE_ID must be set (e.g., 2-237039158)");
  }

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }
}

// Initialize object type names
async function initializeObjectTypes() {
  try {
    propertyObjectName = await findObjectTypeByTypeId(PROPERTY_OBJECT_TYPE_ID, "Property");
    portfolioObjectName = await findObjectTypeByTypeId(PORTFOLIO_OBJECT_TYPE_ID, "Portfolio");
    console.log("✅ Object types initialized successfully\n");
  } catch (error) {
    console.error("❌ Failed to initialize object types:", error.message);
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

// ===== NOTE→PORTFOLIO BATCH SYNC =====

async function fetchNotesBatch(after = null) {
  const response = await hs.get('/crm/v3/objects/notes', {
    params: {
      limit: BATCH_SIZE,
      properties: 'hs_note_body',
      after
    }
  });
  return {
    notes: response.data.results || [],
    after: response.data.paging?.next?.after || null
  };
}

async function getBatchAssociations(objectType, objectIds, toObjectType) {
  if (!objectIds || objectIds.length === 0) return new Map();

  const maxRetries = 5;
  const delays = [1000, 2000, 4000, 8000, 15000];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await hs.post(
        `/crm/v4/associations/${objectType}/${toObjectType}/batch/read`,
        { inputs: objectIds.map(id => ({ id })) }
      );
      
      const associationsMap = new Map();
      const results = response.data.results || [];
      
      for (const result of results) {
        const fromId = result.from?.id;
        if (!fromId) continue;
        const associatedIds = (result.to || [])
          .map(obj => String(obj.toObjectId))
          .filter(Boolean);
        associationsMap.set(fromId, associatedIds);
      }
      
      for (const objectId of objectIds) {
        if (!associationsMap.has(objectId)) {
          associationsMap.set(objectId, []);
        }
      }
      
      return associationsMap;
    } catch (error) {
      if (error.response?.status === 400) {
        return new Map(objectIds.map(id => [id, []]));
      }
      if (error.response?.status === 429 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        continue;
      }
      throw error;
    }
  }
  return new Map();
}

async function createBatchAssociations(associations, associationTypeId) {
  if (associations.length === 0) return 0;

  const maxRetries = 5;
  const delays = [1000, 2000, 4000, 8000, 15000];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const inputs = associations.map(({ fromId, toId }) => ({
        from: { id: fromId },
        to: { id: toId },
        types: [{ associationCategory: "USER_DEFINED", associationTypeId }]
      }));
      
      const response = await hs.post(
        `/crm/v4/associations/notes/${portfolioObjectName}/batch/create`,
        { inputs }
      );
      
      const results = response.data.results || [];
      return results.filter(r => r.from?.id).length;
    } catch (error) {
      if (error.response?.status === 429 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        continue;
      }
      console.error(`Failed to create batch associations:`, error.response?.data || error.message);
      return 0;
    }
  }
  return 0;
}

async function processNoteBatch(notes, associationTypeId) {
  const noteIds = notes.map(n => n.id);
  
  const notePropertyMap = await getBatchAssociations('notes', noteIds, propertyObjectName);
  const notePortfolioMap = await getBatchAssociations('notes', noteIds, portfolioObjectName);
  
  const allPropertyIds = new Set();
  for (const propertyIds of notePropertyMap.values()) {
    propertyIds.forEach(id => allPropertyIds.add(id));
  }
  
  const propertyPortfolioMap = await getBatchAssociations(
    propertyObjectName, 
    Array.from(allPropertyIds), 
    portfolioObjectName
  );
  
  const allMissingAssociations = [];
  
  for (const note of notes) {
    const noteId = note.id;
    const propertyIds = notePropertyMap.get(noteId) || [];
    
    if (propertyIds.length === 0) continue;
    
    const currentPortfolioIds = notePortfolioMap.get(noteId) || [];
    const currentPortfolioSet = new Set(currentPortfolioIds);
    
    const expectedPortfolioIds = new Set();
    for (const propertyId of propertyIds) {
      const portfolioIds = propertyPortfolioMap.get(propertyId) || [];
      portfolioIds.forEach(id => expectedPortfolioIds.add(id));
    }
    
    const missingPortfolioIds = Array.from(expectedPortfolioIds).filter(
      id => !currentPortfolioSet.has(id)
    );
    
    for (const portfolioId of missingPortfolioIds) {
      allMissingAssociations.push({ fromId: noteId, toId: portfolioId });
    }
  }
  
  if (allMissingAssociations.length > 0) {
    return await createBatchAssociations(allMissingAssociations, associationTypeId);
  }
  
  return 0;
}

async function syncNotePortfolioAssociations() {
  const startTime = Date.now();
  console.log('\n🔄 Starting Note→Portfolio batch sync...');
  
  try {
    let allBatches = [];
    let after = null;
    
    while (true) {
      const { notes, after: nextAfter } = await fetchNotesBatch(after);
      if (notes.length === 0) break;
      allBatches.push(notes);
      after = nextAfter;
      if (!nextAfter) break;
    }
    
    console.log(`   Fetched ${allBatches.length} batches (${allBatches.reduce((sum, b) => sum + b.length, 0)} notes)`);
    
    const associationTypeId = await getAssociationTypeId('notes', portfolioObjectName);
    let totalCreated = 0;
    
    for (let i = 0; i < allBatches.length; i += MAX_CONCURRENT_BATCHES) {
      const concurrentBatches = allBatches.slice(i, i + MAX_CONCURRENT_BATCHES);
      
      const results = await Promise.all(
        concurrentBatches.map(batch => processNoteBatch(batch, associationTypeId))
      );
      
      totalCreated += results.reduce((sum, r) => sum + r, 0);
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Sync complete: ${totalCreated} associations created in ${totalTime}s\n`);
  } catch (error) {
    console.error(`   ❌ Sync failed:`, error.message);
  }
}

// ===== SERVER STARTUP =====

(async () => {
  await initializeObjectTypes();
  
  app.listen(PORT, () => {
    console.log("\n🚀 HubSpot Activity Association Service");
    console.log("=====================================");
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Port: ${PORT}`);
    console.log(`Property Object: ${propertyObjectName}`);
    console.log(`Portfolio Object: ${portfolioObjectName}`);
    console.log(`Lookback Window: ${LOOKBACK_MS}ms (${LOOKBACK_MS / 60000} minutes)`);
    console.log(`Polling Interval: ${POLLING_INTERVAL_MINUTES} minutes`);
    console.log(`Polling Lookback: ${POLLING_LOOKBACK_MINUTES} minutes`);
    console.log(`Webhook Secret: ${HUBSPOT_WEBHOOK_SECRET ? "✅ Configured" : "⚠️  Not configured"}`);
    console.log("=====================================\n");
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log("\n✅ Server ready to receive webhooks\n");
    
    // Start polling for Property→Portfolio cascade
    console.log(`🔄 Starting polling for Property associations (every ${POLLING_INTERVAL_MINUTES} minutes)...`);
    
    // Run immediately on startup
    pollPropertyAssociations().catch(err => {
      console.error("❌ Initial polling failed:", err.message);
    });
    
    // Then run on interval
    setInterval(() => {
      pollPropertyAssociations().catch(err => {
        console.error("❌ Polling failed:", err.message);
      });
    }, POLLING_INTERVAL_MINUTES * 60 * 1000);
    
    // Start Note→Portfolio batch sync
    console.log(`🔄 Starting Note→Portfolio sync (every ${NOTE_PORTFOLIO_SYNC_INTERVAL_MINUTES} minutes)...\n`);
    
    // Run immediately on startup
    syncNotePortfolioAssociations().catch(err => {
      console.error("❌ Initial Note→Portfolio sync failed:", err.message);
    });
    
    // Then run on interval
    setInterval(() => {
      syncNotePortfolioAssociations().catch(err => {
        console.error("❌ Note→Portfolio sync failed:", err.message);
      });
    }, NOTE_PORTFOLIO_SYNC_INTERVAL_MINUTES * 60 * 1000);
  });
})();
