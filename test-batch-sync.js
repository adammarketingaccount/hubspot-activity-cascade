/**
 * Test script for batch syncing Note→Property→Portfolio associations
 * 
 * This script scans all notes and ensures they're properly cascaded to portfolios:
 * - Fetches notes in batches
 * - For each note with Property associations, checks if it has corresponding Portfolio associations
 * - Adds missing Portfolio associations
 * 
 * Run locally first to test performance before adding to Railway
 * 
 * Usage:
 *   DRY_RUN=true node test-batch-sync.js   (simulate without creating)
 *   node test-batch-sync.js                (actually create associations)
 */

const axios = require('axios');

const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const PROPERTY_OBJECT_TYPE_ID = process.env.PROPERTY_OBJECT_TYPE_ID || '2-160536042';
const PORTFOLIO_OBJECT_TYPE_ID = process.env.PORTFOLIO_OBJECT_TYPE_ID || '2-237039158';

const BATCH_SIZE = 100; // Notes per batch
const ASSOCIATION_BATCH_SIZE = 100; // Batch size for association reads
const MAX_CONCURRENT_BATCHES = 3; // Process this many note batches in parallel (reduced to avoid rate limits)
const DRY_RUN = process.env.DRY_RUN === 'true'; // Set to 'true' to simulate without creating associations

let propertyObjectName = null;
let portfolioObjectName = null;

// Stats tracking
const stats = {
  notesScanned: 0,
  notesWithProperties: 0,
  notesSkipped: 0,
  associationsCreated: 0,
  associationsAlreadyExist: 0,
  errors: 0,
  startTime: Date.now()
};

// ===== HELPER FUNCTIONS =====

async function findObjectTypeByTypeId(typeId, friendlyName) {
  try {
    const response = await axios.get(`https://api.hubapi.com/crm/v3/schemas`, {
      headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` }
    });

    const schema = response.data.results.find(s => s.objectTypeId === typeId);
    if (!schema) {
      throw new Error(`No schema found for ${friendlyName} with typeId ${typeId}`);
    }

    // Use fullyQualifiedName for custom objects (includes portal ID prefix)
    return schema.fullyQualifiedName || schema.name;
  } catch (error) {
    throw new Error(`Failed to find object type for ${friendlyName}: ${error.message}`);
  }
}

async function fetchNotesBatch(after = null) {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/notes`;
    const params = {
      limit: BATCH_SIZE,
      properties: 'hs_note_body'
    };
    if (after) params.after = after;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` },
      params
    });

    return {
      notes: response.data.results || [],
      after: response.data.paging?.next?.after || null
    };
  } catch (error) {
    console.error(`Error fetching notes batch:`, error.message);
    throw error;
  }
}

async function getBatchAssociations(objectType, objectIds, toObjectType) {
  /**
   * Fetch associations for multiple objects at once using batch API with retry logic
   * Returns: Map of objectId -> [associatedIds]
   */
  if (!objectIds || objectIds.length === 0) {
    return new Map();
  }

  const maxRetries = 5;
  const delays = [1000, 2000, 4000, 8000, 15000]; // milliseconds
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://api.hubapi.com/crm/v4/associations/${objectType}/${toObjectType}/batch/read`;
      const inputs = objectIds.map(id => ({ id }));
      
      const response = await axios.post(url, { inputs }, {
        headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` }
      });
      
      const results = response.data.results || [];
      const associationsMap = new Map();
      
      // Parse results
      for (const result of results) {
        const fromId = result.from?.id;
        if (!fromId) continue;
        
        const toObjects = result.to || [];
        // Convert toObjectId to string to match note.id format
        const associatedIds = toObjects.map(obj => String(obj.toObjectId)).filter(Boolean);
        associationsMap.set(fromId, associatedIds);
      }
      
      // Add empty arrays for objects with no associations
      for (const objectId of objectIds) {
        if (!associationsMap.has(objectId)) {
          associationsMap.set(objectId, []);
        }
      }
      
      return associationsMap;
    } catch (error) {
      if (error.response?.status === 400) {
        console.log(`   [SKIP] Cannot check ${toObjectType} associations (400)`);
        return new Map(objectIds.map(id => [id, []]));
      }
      
      if (error.response?.status === 429 && attempt < maxRetries) {
        const delay = delays[attempt];
        console.log(`   ⏳ Rate limit hit, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
}

async function getAssociations(objectType, objectId, toObjectType, limit = 500) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v4/objects/${objectType}/${objectId}/associations/${toObjectType}`,
      {
        headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` },
        params: { limit }
      }
    );
    return response.data.results.map(r => r.toObjectId);
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }
    if (error.response?.status === 400) {
      // Bad request - likely invalid object type combination
      console.log(`   [SKIP] Note ${objectId}: Cannot check ${toObjectType} associations (400)`);
      return [];
    }
    throw error;
  }
}

async function createBatchAssociations(fromObjectType, associations, toObjectType, associationTypeId) {
  /**
   * Create multiple associations at once using batch API
   * associations: Array of { fromId, toId }
   */
  if (associations.length === 0) {
    return { created: 0, alreadyExist: 0, errors: 0 };
  }
  
  if (DRY_RUN) {
    associations.forEach(({ fromId, toId }) => {
      console.log(`   [DRY RUN] Would create: ${fromObjectType}/${fromId} → ${toObjectType}/${toId}`);
    });
    return { created: associations.length, alreadyExist: 0, errors: 0 };
  }
  
  // SAFETY CHECK: Only allow Note→Portfolio associations
  if (fromObjectType !== 'notes' || toObjectType !== portfolioObjectName) {
    console.error(`❌ BLOCKED: Attempted to create unauthorized association: ${fromObjectType}→${toObjectType}`);
    return { created: 0, alreadyExist: 0, errors: associations.length };
  }
  
  const maxRetries = 5;
  const delays = [1000, 2000, 4000, 8000, 15000];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const inputs = associations.map(({ fromId, toId }) => ({
        from: { id: fromId },
        to: { id: toId },
        types: [{ associationCategory: "USER_DEFINED", associationTypeId }]
      }));
      
      const response = await axios.post(
        `https://api.hubapi.com/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/create`,
        { inputs },
        {
          headers: {
            Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Count results
      const results = response.data.results || [];
      const created = results.filter(r => r.from?.id).length;
      
      return { created, alreadyExist: 0, errors: 0 };
    } catch (error) {
      if (error.response?.status === 429 && attempt < maxRetries) {
        const delay = delays[attempt];
        console.log(`   ⏳ Rate limit hit on batch create, retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      console.error(`Failed to create batch associations:`, error.response?.data || error.message);
      return { created: 0, alreadyExist: 0, errors: associations.length };
    }
  }
  
  return { created: 0, alreadyExist: 0, errors: associations.length };
}

async function getAssociationTypeId(fromObjectType, toObjectType) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`,
      {
        headers: { Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}` }
      }
    );
    
    const userDefined = response.data.results.find(r => r.category === "USER_DEFINED");
    return userDefined?.typeId || 1;
  } catch (error) {
    console.warn(`Could not fetch association type ID, using default:`, error.message);
    return 1;
  }
}

// ===== CORE SYNC LOGIC =====

async function processNoteBatch(notes) {
  /**
   * Process a batch of notes efficiently:
   * 1. Batch fetch Property associations for all notes
   * 2. Batch fetch Portfolio associations for all notes
   * 3. For notes with Properties, batch fetch Property→Portfolio associations
   * 4. Create missing Note→Portfolio associations
   */
  
  const noteIds = notes.map(n => n.id);
  
  // Step 1: Batch fetch Property associations for all notes
  const notePropertyMap = await getBatchAssociations('notes', noteIds, propertyObjectName);
  
  // Step 2: Batch fetch current Portfolio associations for all notes
  const notePortfolioMap = await getBatchAssociations('notes', noteIds, portfolioObjectName);
  
  // Step 3: Find all unique Properties across these notes
  const allPropertyIds = new Set();
  for (const propertyIds of notePropertyMap.values()) {
    propertyIds.forEach(id => allPropertyIds.add(id));
  }
  
  // Step 4: Batch fetch Portfolio associations for all Properties
  const propertyPortfolioMap = await getBatchAssociations(
    propertyObjectName, 
    Array.from(allPropertyIds), 
    portfolioObjectName
  );
  
  // Step 5: Process each note and create missing associations
  let created = 0;
  let alreadyExist = 0;
  let skipped = 0;
  
  // Collect all missing associations to create in batch
  const allMissingAssociations = [];
  
  // Get association type ID once (cache it)
  let associationTypeId = null;
  
  for (const note of notes) {
    const noteId = note.id;
    stats.notesScanned++;
    
    try {
      const propertyIds = notePropertyMap.get(noteId) || [];
      
      if (propertyIds.length === 0) {
        stats.notesSkipped++;
        skipped++;
        continue;
      }
      
      stats.notesWithProperties++;
      
      // Get current Portfolio associations for this note
      const currentPortfolioIds = notePortfolioMap.get(noteId) || [];
      const currentPortfolioSet = new Set(currentPortfolioIds);
      
      // Find all Portfolios this note should be associated with
      const expectedPortfolioIds = new Set();
      for (const propertyId of propertyIds) {
        const portfolioIds = propertyPortfolioMap.get(propertyId) || [];
        portfolioIds.forEach(id => expectedPortfolioIds.add(id));
      }
      
      // Find missing associations
      const missingPortfolioIds = Array.from(expectedPortfolioIds).filter(
        id => !currentPortfolioSet.has(id)
      );
      
      // Collect missing associations
      for (const portfolioId of missingPortfolioIds) {
        allMissingAssociations.push({ fromId: noteId, toId: portfolioId });
      }
    } catch (error) {
      console.error(`Error processing note ${noteId}:`, error.message);
      stats.errors++;
    }
  }
  
  // Create all missing associations in one batch call
  if (allMissingAssociations.length > 0) {
    // Get association type ID if needed
    if (!associationTypeId) {
      associationTypeId = await getAssociationTypeId('notes', portfolioObjectName);
    }
    
    const result = await createBatchAssociations('notes', allMissingAssociations, portfolioObjectName, associationTypeId);
    created = result.created;
    alreadyExist = result.alreadyExist;
    stats.associationsCreated += result.created;
    stats.associationsAlreadyExist += result.alreadyExist;
    stats.errors += result.errors;
  }
  
  return { created, alreadyExist, skipped };
}

// ===== MAIN EXECUTION =====

async function runSync() {
  console.log('🚀 Starting Note→Property→Portfolio batch sync\n');
  
  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No associations will be created\n');
  }
  
  // Initialize object type names
  console.log('📋 Initializing object types...');
  propertyObjectName = await findObjectTypeByTypeId(PROPERTY_OBJECT_TYPE_ID, "Property");
  portfolioObjectName = await findObjectTypeByTypeId(PORTFOLIO_OBJECT_TYPE_ID, "Portfolio");
  console.log(`   Property: ${propertyObjectName}`);
  console.log(`   Portfolio: ${portfolioObjectName}\n`);
  
  let after = null;
  let batchNum = 0;
  let allBatches = [];
  
  // First, collect all note batches
  console.log('📥 Fetching all notes...');
  while (true) {
    const { notes, after: nextAfter } = await fetchNotesBatch(after);
    
    if (notes.length === 0) {
      break;
    }
    
    allBatches.push(notes);
    after = nextAfter;
    
    if (!nextAfter) {
      break;
    }
  }
  
  console.log(`✓ Fetched ${allBatches.length} batches (${allBatches.reduce((sum, b) => sum + b.length, 0)} total notes)\n`);
  
  // Process batches in parallel groups
  for (let i = 0; i < allBatches.length; i += MAX_CONCURRENT_BATCHES) {
    const concurrentBatches = allBatches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const batchNums = Array.from({ length: concurrentBatches.length }, (_, idx) => i + idx + 1);
    
    console.log(`📦 Processing batches ${batchNums[0]}-${batchNums[batchNums.length - 1]} in parallel...`);
    const batchStart = Date.now();
    
    // Process all batches in this group concurrently
    const results = await Promise.all(
      concurrentBatches.map(batch => processNoteBatch(batch))
    );
    
    const batchTime = ((Date.now() - batchStart) / 1000).toFixed(2);
    const notesProcessed = concurrentBatches.reduce((sum, b) => sum + b.length, 0);
    const notesPerSec = (notesProcessed / (Date.now() - batchStart) * 1000).toFixed(1);
    
    console.log(`   ✓ Parallel group complete in ${batchTime}s (${notesPerSec} notes/sec)`);
    console.log(`   Progress: ${stats.notesScanned} scanned, ${stats.notesWithProperties} with properties, ${stats.associationsCreated} created\n`);
  }
  
  // Print final stats
  const totalTime = ((Date.now() - stats.startTime) / 1000).toFixed(2);
  const avgRate = (stats.notesScanned / (Date.now() - stats.startTime) * 1000).toFixed(1);
  
  console.log('====================================');
  console.log('📊 SYNC COMPLETE');
  console.log('====================================');
  console.log(`Total time: ${totalTime}s`);
  console.log(`Notes scanned: ${stats.notesScanned}`);
  console.log(`Notes with properties: ${stats.notesWithProperties}`);
  console.log(`Notes skipped: ${stats.notesSkipped}`);
  console.log(`Associations created: ${stats.associationsCreated}`);
  console.log(`Already existed: ${stats.associationsAlreadyExist}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Average rate: ${avgRate} notes/sec`);
  console.log('====================================\n');
}

// Run the sync
runSync().catch(error => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
