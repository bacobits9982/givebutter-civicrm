const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

app.use(express.json());

// Configuration
const GIVEBUTTER_WEBHOOK_SECRET = process.env.GIVEBUTTER_WEBHOOK_SECRET;
const CIVICRM_BASE_URL = process.env.CIVICRM_BASE_URL; // e.g., https://yoursite.org
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
    
    const response = await axios.get(CIVICRM_REST_URL, {
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
  
  if (searchResult.count > 0) {
    console.log('✅ Found existing contact:', searchResult.values[0].id);
    return searchResult.values[0].id;
  }
  
  console.log('➕ Creating new contact');
  const createResult = await civiCRMApi('Contact', 'create', {
    contact_type: 'Individual',
    first_name: data.first_name,
    last_name: data.last_name,
    email: data.email,
    ...(data.phone && { phone: data.phone })
  });
  
  console.log('✅ Created new contact:', createResult.id);
  return createResult.id;
}

// Create contribution
async function createContribution(contactId, transaction) {
  console.log('💰 Creating contribution for contact:', contactId);
  
  const contributionData = {
    contact_id: contactId,
    financial_type_id: 1,
    total_amount: transaction.amount / 100,
    receive_date: transaction.transacted_at || new Date().toISOString(),
    source: `Givebutter: ${transaction.campaign_id || 'Unknown Campaign'}`,
    trxn_id: transaction.id,
    invoice_id: transaction.id,
    contribution_status_id: 1,
    payment_instrument_id: 1
  };
  
  console.log('📝 Contribution data:', contributionData);
  
  const result = await civiCRMApi('Contribution', 'create', contributionData);
  
  console.log('✅ Created contribution:', result.id);
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
      amount: 2500,
      transacted_at: new Date().toISOString(),
      campaign_id: 'test-campaign',
      first_name: 'Test',
      last_name: 'Donor',
      email: 'test@example.com',
      phone: '555-1234'
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
  console.log('🔗 CiviCRM endpoint: ${CIVICRM_REST_URL}');
  console.log('📍 Endpoints:');
  console.log('   POST /webhook/givebutter - Receive webhooks');
  console.log('   GET  /health - Health check');
  console.log('   POST /test - Test with sample data\n');
});
