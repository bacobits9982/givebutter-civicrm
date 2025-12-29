const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

app.use(express.json());

// Configuration
const GIVEBUTTER_WEBHOOK_SECRET = process.env.GIVEBUTTER_WEBHOOK_SECRET;
const GIVEBUTTER_API_KEY = process.env.GIVEBUTTER_API_KEY;
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

// Fetch plan details from Givebutter API
async function getGivebutterPlan(planId) {
  if (!planId || !GIVEBUTTER_API_KEY) {
    return null;
  }
  
  try {
    console.log('📡 Fetching plan details from Givebutter:', planId);
    
    const response = await axios.get(`https://api.givebutter.com/v1/plans/${planId}`, {
      headers: {
        'Authorization': `Bearer ${GIVEBUTTER_API_KEY}`
      }
    });
    
    console.log('✅ Got plan details:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to fetch plan from Givebutter:', error.response?.data || error.message);
    return null;
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
  
  const searchResult = await civiCRMApi('Contact', 'get', {
    email: data.email,
    sequential: 1,
    return: 'id,display_name,custom_820'
  });
  
  if (searchResult.count > 0 && searchResult.values && searchResult.values.length > 0) {
    const contact = searchResult.values[0];
    const contactId = contact.id || contact.contact_id;
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
  
  return {
    id: contactId,
    localArea: null
  };
}

// Update contact's local area field
async function updateContactLocalArea(contactId, localArea) {
  console.log('💾 Updating contact', contactId, 'with Local Area:', localArea);
  
  try {
    await civiCRMApi('Contact', 'create', {
      id: contactId,
      custom_820: localArea
    });
    console.log('✅ Contact Local Area updated');
  } catch (error) {
    console.error('❌ Failed to update contact Local Area:', error);
  }
}

// Create or renew membership
async function createOrRenewMembership(contactId, contributionId, transaction, frequency) {
  console.log('👥 Checking membership for contact:', contactId);
  console.log('📊 Frequency:', frequency);
  
  // Determine membership type based on frequency and is_recurring
  let membershipTypeId;
  let membershipDuration;
  
  if (!transaction.is_recurring) {
    // One-time donation = Annual Non-Renewing
    membershipTypeId = 11;
    membershipDuration = { years: 1 };
    console.log('💳 One-time donation → Type 11 (Annual Non-Renewing)');
  } else if (frequency === 'monthly') {
    // Monthly recurring = Monthly Renewing Membership
    membershipTypeId = 10;
    membershipDuration = { months: 1 };
    console.log('💳 Monthly recurring → Type 10 (Monthly Renewing)');
  } else if (frequency === 'yearly' || frequency === 'annual') {
    // Annual recurring = Annual Renewing Membership
    membershipTypeId = 9;
    membershipDuration = { years: 1 };
    console.log('💳 Annual recurring → Type 9 (Annual Renewing)');
  } else if (frequency === 'quarterly') {
    // Quarterly - treat as monthly for now
    membershipTypeId = 10;
    membershipDuration = { months: 3 };
    console.log('💳 Quarterly recurring → Type 10 (Monthly Renewing, 3 months)');
  } else {
    // Default to annual non-renewing if we can't determine
    membershipTypeId = 11;
    membershipDuration = { years: 1 };
    console.log('⚠️  Unknown frequency, defaulting to Type 11 (Annual Non-Renewing)');
  }
  
  try {
    // Check if contact has an existing membership of this type
    const existingMembership = await civiCRMApi('Membership', 'get', {
      contact_id: contactId,
      membership_type_id: membershipTypeId,
      sequential: 1,
      options: { limit: 1, sort: 'end_date DESC' }
    });
    
    const today = new Date();
    let startDate = new Date();
    let endDate = new Date();
    
    // Calculate end date based on duration
    if (membershipDuration.years) {
      endDate.setFullYear(startDate.getFullYear() + membershipDuration.years);
    } else if (membershipDuration.months) {
      endDate.setMonth(startDate.getMonth() + membershipDuration.months);
    }
    
    let membershipData = {
      contact_id: contactId,
      membership_type_id: membershipTypeId,
      source: `Givebutter: ${transaction.campaign_title || transaction.campaign_id}`,
      contribution_id: contributionId
    };
    
    if (existingMembership.count > 0) {
      const existingId = existingMembership.values[0].id;
      const existingEndDate = new Date(existingMembership.values[0].end_date);
      
      console.log('🔄 Renewing existing membership:', existingId);
      
      // If membership hasn't expired yet, extend from end date
      if (existingEndDate > today) {
        startDate = new Date(existingEndDate);
        startDate.setDate(startDate.getDate() + 1);
        endDate = new Date(startDate);
        
        if (membershipDuration.years) {
          endDate.setFullYear(endDate.getFullYear() + membershipDuration.years);
        } else if (membershipDuration.months) {
          endDate.setMonth(endDate.getMonth() + membershipDuration.months);
        }
      }
      
      membershipData.id = existingId;
      membershipData.start_date = startDate.toISOString().split('T')[0];
      membershipData.end_date = endDate.toISOString().split('T')[0];
      membershipData.status_id = 1;
      
    } else {
      console.log('➕ Creating new membership');
      
      membershipData.join_date = today.toISOString().split('T')[0];
      membershipData.start_date = startDate.toISOString().split('T')[0];
      membershipData.end_date = endDate.toISOString().split('T')[0];
      membershipData.status_id = 1;
    }
    
    console.log('📝 Membership data:', membershipData);
    
    const result = await civiCRMApi('Membership', 'create', membershipData);
    
    const membershipId = result.id || 
                        (result.values && result.values[0] && result.values[0].id) ||
                        (result.values && Object.keys(result.values)[0]);
    
    console.log('✅ Membership created/renewed:', membershipId);
    return membershipId;
    
  } catch (error) {
    console.error('❌ Failed to create/renew membership:', error);
    return null;
  }
}

// Create contribution
async function createContribution(contactInfo, transaction) {
  console.log('💰 Creating contribution for contact:', contactInfo.id);
  console.log('📋 Campaign ID:', transaction.campaign_id);
  console.log('📋 Campaign Title:', transaction.campaign_title);
  
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
  
  const campaignFinancialTypeMapping = {
    '195519': 'use_custom_field'
  };
  
  let financialTypeId = 49;
  let localAreaValue = null;
  let shouldUpdateContact = false;
  
  const campaignMapping = campaignFinancialTypeMapping[transaction.campaign_id];
  
  if (campaignMapping === 'use_custom_field') {
    if (transaction.custom_fields && transaction.custom_fields.length > 0) {
      const localAreaField = transaction.custom_fields.find(
        field => field.title === 'Local Area' || field.field_id === 64260
      );
      
      if (localAreaField && localAreaField.value) {
        localAreaValue = localAreaField.value;
        console.log('📍 Found Local Area in transaction:', localAreaValue);
        
        if (!contactInfo.localArea || contactInfo.localArea !== localAreaValue) {
          shouldUpdateContact = true;
        }
      }
    }
    
    if (!localAreaValue && contactInfo.localArea) {
      localAreaValue = contactInfo.localArea;
      console.log('📍 Using stored Local Area from contact:', localAreaValue);
    }
    
    if (shouldUpdateContact && localAreaValue) {
      await updateContactLocalArea(contactInfo.id, localAreaValue);
    }
    
    if (localAreaValue) {
      financialTypeId = localAreaMapping[localAreaValue] || 49;
      console.log('💳 Using Financial Type ID:', financialTypeId, 'for Local Area:', localAreaValue);
    } else {
      console.log('⚠️  No Local Area found, using default:', financialTypeId);
    }
    
  } else if (campaignMapping) {
    financialTypeId = campaignMapping;
    console.log('💳 Using Financial Type ID from campaign mapping:', financialTypeId);
  } else {
    console.log('⚠️  Campaign not in mapping, using default:', financialTypeId);
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
  
  // Create/renew membership for campaign 195519
  if (transaction.campaign_id === '195519') {
    let frequency = null;
    
    // Fetch plan details if this is a recurring donation
    if (transaction.plan_id) {
      const planDetails = await getGivebutterPlan(transaction.plan_id);
      if (planDetails && planDetails.frequency) {
        frequency = planDetails.frequency;
      }
    }
    
    await createOrRenewMembership(contactInfo.id, contributionId, transaction, frequency);
  }
  
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
      
      console.log('🎉 SUCCESS! Contribution created');
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
      hasGivebutterApiKey: !!GIVEBUTTER_API_KEY,
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
      campaign_id: '195519',
      campaign_title: 'Test Campaign',
      first_name: 'Test',
      last_name: 'Donor',
      email: 'testdonor@example.com',
      phone: '555-1234',
      is_recurring: true,
      plan_id: null, // Set to actual plan ID to test
      custom_fields: [
        {
          id: 20768768,
          field_id: 64260,
          title: 'Local Area',
          type: 'radio',
          value: 'Colorado'
        }
      ]
    };
    
    const contactInfo = await findOrCreateContact(testData);
    const contribution = await createContribution(contactInfo, testData);
    
    console.log('✅ Test successful!');
    console.log('===================================\n');
    
    res.json({ 
      success: true, 
      message: 'Test donation created successfully',
      contact_id: contactInfo.id
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
