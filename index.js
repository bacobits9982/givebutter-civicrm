const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

app.use(express.json());

// Configuration
const GIVEBUTTER_WEBHOOK_SECRET = process.env.GIVEBUTTER_WEBHOOK_SECRET;
const CIVICRM_BASE_URL = process.env.CIVICRM_BASE_URL;
const CIVICRM_SITE_KEY = process.env.CIVICRM_SITE_KEY;
const CIVICRM_API_KEY = process.env.CIVICRM_API_KEY;

// CiviCRM REST endpoint for Drupal 7
const CIVICRM_REST_URL = `${CIVICRM_BASE_URL}/sites/all/modules/civicrm/extern/rest.php`;

function verifyGivebutterSignature(req, res, next) {
  const signature = req.headers['givebutter-signature'];
  
  if (!signature) {
    console.log('⚠️  No signature provided - skipping verification for testing');
    next();
    return;
  }
  
  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', GIVEBUTTER_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  
  if (signature === expectedSignature) {
    console.log('✅ Signature verified');
    next();
  } else {
    console.error('❌ Invalid webhook signature');
    res.sendStatus(401);
  }
}

// CiviCRM API helper for Drupal 7 (APIv3)
async function civiCRMApi(entity, action, params) {
  try {
    console.log(`📡 CiviCRM API call: ${entity}.${action}`);
    
    const response = await axios.post(CIVICRM_REST_URL, null, {
      params: {
        entity: entity,
        action: action,
        key: CIVICRM_SITE_KEY,
        api_key: CIVICRM_API_KEY,
        json: JSON.stringify(params)
      }
    });
    
    console.log(`✅ ${entity}.${action} successful`);
    return response.data;
  } catch (error) {
    console.error(`❌ CiviCRM API Error (${entity}.${action}):`, error.response?.data || error.message);
    throw error;
  }
}

// Find or create contact and return contact info including local area
async function findOrCreateContact(data) {
  console.log('🔍 Searching for contact:', data.email);
  
  // Search with return fields to get custom fields
  const searchResult = await civiCRMApi('Contact', 'get', {
    email: data.email,
    sequential: 1,
    return: 'id,display_name,custom_820'  // custom_820 is the local_area_820 field
  });
  
  if (searchResult.count > 0 && searchResult.values && searchResult.values.length > 0) {
    const contact = searchResult.values[0];
    const contactId = contact.id || contact.contact_id;
    
    // Extract local area from contact record
    const storedLocalArea = contact.custom_820 || null;
    
    console.log('✅ Found existing contact:', contactId);
    if (storedLocalArea) {
      console.log('📍 Contact has stored Local Area:', storedLocalArea);
    } else {
      console.log('⚠️  Contact has no stored Local Area');
    }
    
    return {
      id: contactId,
      localArea: storedLocalArea
    };
  }
  
  console.log('➕ Creating new contact');
  const createResult = await civiCRMApi('Contact', 'create', {
    contact_type: 'Individual',
    first_name: data.first_name,
    last_name: data.last_name,
    email: data.email,
    ...(data.phone && { phone: data.phone })
  });
  
  const contactId = createResult.id || 
                    (createResult.values && createResult.values[0] && createResult.values[0].id) ||
                    (createResult.values && Object.keys(createResult.values)[0]);
  
  console.log('✅ Created new contact:', contactId);
  console.log('📋 Full response:', JSON.stringify(createResult, null, 2));
  
  return {
    id: contactId,
    localArea: null  // New contact has no stored local area
  };
}

// Update contact's local area field
async function updateContactLocalArea(contactId, localArea) {
  console.log('💾 Updating contact', contactId, 'with Local Area:', localArea);
  
  try {
    await civiCRMApi('Contact', 'create', {
      id: contactId,
      custom_820: localArea  // Update the local_area_820 field
    });
    console.log('✅ Contact Local Area updated');
  } catch (error) {
    console.error('❌ Failed to update contact Local Area:', error);
    // Don't throw - we still want to create the contribution
  }
}

// Create contribution
async function createContribution(contactInfo, transaction) {
  console.log('💰 Creating contribution for contact:', contactInfo.id);
  console.log('📋 Campaign ID:', transaction.campaign_id);
  console.log('📋 Campaign Title:', transaction.campaign_title);
  
  // Financial type mapping for "Local Area" custom field
  const localAreaMapping = {
    'MKP USA': 49,
    'Central Plains': 18,
    'Chicago': 19,
    'Colorado': 20,
    'Florida': 21,
    'Greater Carolinas': 23,
    'Hawaii': 25,
    'Heartland': 139,
    'Intermountain': 28,
    'Metro NY Tri-State': 36,
    'Mid Atlantic': 24,
    'Mid America': 27,
    'New England': 34,
    'Northern California': 40,
    'Northwest': 41,
    'Philadelphia': 42,
    'Southern California': 31,
    'South Central': 51,
    'South East': 22,
    'Southwest': 17,
    'St. Louis': 45,
    'Upstate New York': 46,
    'Wisconsin': 48
  };
  
  // Campaign-specific financial type mapping
  const campaignFinancialTypeMapping = {
    '195519': 'use_custom_field',  // Main campaign - use Local Area custom field
    // Add other campaigns here:
    // '123456': 1,  // Example: Different campaign uses Financial Type ID 1
  };
  
  let financialTypeId = 49; // Default to MKP USA
  let localAreaValue = null;
  let shouldUpdateContact = false;
  
  // Check if this campaign has specific mapping
  const campaignMapping = campaignFinancialTypeMapping[transaction.campaign_id];
  
  if (campaignMapping === 'use_custom_field') {
    // This is the main campaign - use Local Area custom field
    
    // First, check if Local Area was provided in the transaction
    if (transaction.custom_fields && transaction.custom_fields.length > 0) {
      const localAreaField = transaction.custom_fields.find(
        field => field.title === 'Local Area' || field.field_id === 64260
      );
      
      if (localAreaField && localAreaField.value) {
        localAreaValue = localAreaField.value;
        console.log('📍 Found Local Area in transaction:', localAreaValue);
        
        // If contact doesn't have this local area stored, we should update it
        if (!contactInfo.localArea || contactInfo.localArea !== localAreaValue) {
          shouldUpdateContact = true;
        }
      }
    }
    
    // If no Local Area in transaction, use the one from contact record
    if (!localAreaValue && contactInfo.localArea) {
      localAreaValue = contactInfo.localArea;
      console.log('📍 Using stored Local Area from contact:', localAreaValue);
    }
    
    // Update contact record if needed
    if (shouldUpdateContact && localAreaValue) {
      await updateContactLocalArea(contactInfo.id, localAreaValue);
    }
    
    // Map the local area value to financial type ID
    if (localAreaValue) {
      financialTypeId = localAreaMapping[localAreaValue] || 49;
      console.log('💳 Using Financial Type ID:', financialTypeId, 'for Local Area:', localAreaValue);
    } else {
      console.log('⚠️  No Local Area found in transaction or contact record, using default:', financialTypeId);
    }
    
  } else if (campaignMapping) {
    // Use the specified financial type for this campaign
    financialTypeId = campaignMapping;
    console.log('💳 Using Financial Type ID from campaign mapping:', financialTypeId);
  } else {
    // Campaign not in mapping - use default
    console.log('⚠️  Campaign not in mapping, using default Financial Type ID:', financialTypeId);
  }
  
  const contributionData = {
    contact_id: contactInfo.id,
    financial_type_id: financialTypeId,
    total_amount: transaction.amount,
    receive_date: transaction.transacted_at || new Date().toISOString(),
    source: `Givebutter: ${transaction.campaign_title || transaction.campaign_id || 'Unknown Campaign'}`,
    trxn_id: transaction.id,
    invoice_id: transaction.id,
    contribution_status_id: 1,
    payment_instrument_id: 1
  };
  
  console.log('📝 Contribution data:', contributionData);
  
  const result = await civiCRMApi('Contribution', 'create', contributionData);
  
  const contributionId = result.id || 
                        (result.values && result.values[0] && result.values[0].id) ||
                        (result.values && Object.keys(result.values)[0]);
  
  console.log('✅ Created contribution:', contributionId);
  console.log('📋 Full response:', JSON.stringify(result, null, 2));
  return result;
}

// Webhook endpoint
app.post('/webhook/givebutter', verifyGivebutterSignature, async (req, res) => {
  const { event, data } = req.body;
  
  console.log('\n🎯 ========== NEW WEBHOOK ==========');
  console.log('📅 Time:', new Date().toISOString());
  console.log('📧 Event:', event);
  console.log('📦 Data:', JSON.stringify(data, null, 2));
  
  try {
    if (event === 'transaction.succeeded') {
      const contactInfo = await findOrCreateContact({
        first_name: data.first_name || data.member?.first_name,
        last_name: data.last_name || data.member?.last_name,
        email: data.email || data.member?.email,
        phone: data.phone || data.member?.phone
      });
      
      const contribution = await createContribution(contactInfo, data);
      
      console.log('🎉 SUCCESS! Contribution created:', contribution.id);
      console.log('===================================\n');
      
      res.status(200).json({ 
        success: true, 
        contact_id: contactInfo.id,
        contribution_id: contribution.id
      });
    } else {
      console.log(`ℹ️  Unhandled event type: ${event}`);
      console.log('===================================\n');
      res.sendStatus(200);
    }
  } catch (error) {
    console.error('💥 ERROR processing webhook:', error);
    console.error('Stack:', error.stack);
    console.log('===================================\n');
    res.status(200).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  console.log('💚 Health check');
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    civicrm_endpoint: CIVICRM_REST_URL,
    config: {
      hasGivebutterSecret: !!GIVEBUTTER_WEBHOOK_SECRET,
      hasCiviCRMUrl: !!CIVICRM_BASE_URL,
      hasSiteKey: !!CIVICRM_SITE_KEY,
      hasApiKey: !!CIVICRM_API_KEY
    }
  });
});

// Test endpoint
app.post('/test', async (req, res) => {
  console.log('\n🧪 ========== TEST MODE ==========');
  
  try {
    const testData = {
      id: 'test_' + Date.now(),
      amount: 25,
      transacted_at: new Date().toISOString(),
      campaign_id: '195519',  // Use main campaign to test local area logic
      campaign_title: 'Test Campaign',
      first_name: 'Test',
      last_name: 'Donor',
      email: 'testdonor@example.com',
      phone: '555-1234',
      // Uncomment to test with custom field provided:
      custom_fields: [
        {
          id: 20768768,
          field_id: 64260,
          title: 'Local Area',
          type: 'radio',
          value: 'Colorado'  // Change to test different areas
        }
      ]
      // Comment out custom_fields to test database lookup
    };
    
    const contactInfo = await findOrCreateContact(testData);
    const contribution = await createContribution(contactInfo, testData);
    
    console.log('✅ Test successful!');
    console.log('===================================\n');
    
    res.json({ 
      success: true, 
      message: 'Test donation created successfully',
      contact_id: contactInfo.id,
      contribution_id: contribution.id
    });
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.log('===================================\n');
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Webhook server running on port ${PORT}`);
  console.log(`🔗 CiviCRM endpoint: ${CIVICRM_REST_URL}`);
  console.log('📍 Endpoints:');
  console.log('   POST /webhook/givebutter - Receive webhooks');
  console.log('   GET  /health - Health check');
  console.log('   POST /test - Test with sample data\n');
});
