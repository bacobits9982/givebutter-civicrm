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

// Find or create contact
async function findOrCreateContact(data) {
  console.log('🔍 Searching for contact:', data.email);
  
  const searchResult = await civiCRMApi('Contact', 'get', {
    email: data.email,
    sequential: 1
  });
  
  if (searchResult.count > 0 && searchResult.values && searchResult.values.length > 0) {
    const contactId = searchResult.values[0].id || searchResult.values[0].contact_id;
    console.log('✅ Found existing contact:', contactId);
    return contactId;
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
  return contactId;
}

// Create contribution
async function createContribution(contactId, transaction) {
  console.log('💰 Creating contribution for contact:', contactId);
  
  // Map Givebutter custom field values to CiviCRM Financial Type IDs
  const financialTypeMapping = {
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
  
  // Find the "Local Area" custom field value
  let financialTypeId = 49; // Default to MKP USA if no match
  
  if (transaction.custom_fields && transaction.custom_fields.length > 0) {
    const localAreaField = transaction.custom_fields.find(
      field => field.title === 'Local Area' || field.field_id === 64260
    );
    
    if (localAreaField && localAreaField.value) {
      console.log('📍 Found custom field value:', localAreaField.value);
      financialTypeId = financialTypeMapping[localAreaField.value] || 49;
      console.log('💳 Using Financial Type ID:', financialTypeId);
    }
  }
  
  const contributionData = {
    contact_id: contactId,
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
      const contactId = await findOrCreateContact({
        first_name: data.first_name || data.member?.first_name,
        last_name: data.last_name || data.member?.last_name,
        email: data.email || data.member?.email,
        phone: data.phone || data.member?.phone
      });
      
      const contribution = await createContribution(contactId, data);
      
      console.log('🎉 SUCCESS! Contribution created:', contribution.id);
      console.log('===================================\n');
      
      res.status(200).json({ 
        success: true, 
        contact_id: contactId,
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
      campaign_id: 'test-campaign',
      campaign_title: 'Test Campaign',
      first_name: 'Test',
      last_name: 'Donor',
      email: 'testdonor@example.com',
      phone: '555-1234',
      custom_fields: [
        {
          id: 20768768,
          field_id: 64260,
          title: 'Local Area',
          type: 'radio',
          value: 'Colorado'  // Change this to test different areas
        }
      ]
    };
    
    const contactId = await findOrCreateContact(testData);
    const contribution = await createContribution(contactId, testData);
    
    console.log('✅ Test successful!');
    console.log('===================================\n');
    
    res.json({ 
      success: true, 
      message: 'Test donation created successfully',
      contact_id: contactId,
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
