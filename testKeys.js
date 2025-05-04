// testKeys.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');

const testOpenAI = async () => {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('Testing OpenAI: Listing models...');
    const response = await openai.models.list();
    // console.log('OpenAI Models sample:', response.data?.slice(0, 2)); // Log first few models
    console.log(`OpenAI OK: Found ${response.data?.length} models.`);
    return true;
  } catch (error) {
    console.error('OpenAI Test FAILED:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
    return false;
  }
};

const testSupabase = async () => {
  try {
    console.log('Testing Supabase connection...');
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        throw new Error('SupABASE_URL or SUPABASE_ANON_KEY not found in .env file.');
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    // Try a simple metadata query (won't return data unless you have a table)
    // This mainly tests if the URL/key allows connection initialization
    const { error } = await supabase.from('non_existent_table_test').select('*').limit(1);
    // We expect an error like 'relation "non_existent_table_test" does not exist' if connection is OK
    if (error && error.message.includes('does not exist')) {
         console.log('Supabase OK: Connection successful (table query failed as expected).');
         return true;
    } else if (error) {
        throw error; // Throw unexpected Supabase errors
    } else {
        // This case might happen if RLS prevents even checking if the table exists,
        // but the connection itself didn't fail authentication. Consider it OK.
        console.log('Supabase OK: Connection successful (Query blocked or succeeded unexpectedly - check RLS if issues arise later).');
        return true;
    }
  } catch (error) {
    console.error('Supabase Test FAILED:', error.message);
    return false;
  }
};

const testGoogleNews = async () => {
    // --- Using Google Custom Search API ---
     const API_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
     const params = {
         key: process.env.GOOGLE_API_KEY, // Assuming key is stored as GOOGLE_API_KEY
         cx: process.env.GOOGLE_SEARCH_ENGINE_ID, // Read the CX ID from .env
         q: 'microplastic', // Test query
         num: 1
     };
    // --- --- --- --- --- --- --- --- --- --- ---

    if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_SEARCH_ENGINE_ID) {
        console.warn('Google API Test SKIPPED: GOOGLE_API_KEY or GOOGLE_SEARCH_ENGINE_ID not found in .env file.');
        return false;
    }

    try {
        console.log(`Testing Google Custom Search API (${API_ENDPOINT} with key starting: ${process.env.GOOGLE_API_KEY.substring(0, 5)}... and CX ID starting: ${process.env.GOOGLE_SEARCH_ENGINE_ID.substring(0, 5)}...)...`);
        const response = await axios.get(API_ENDPOINT, { params });
        console.log('Google Custom Search API OK: Received response (status', response.status + ').');
        // console.log('Sample result:', response.data?.items?.[0]?.title);
        return true;
    } catch (error) {
        console.error('Google Custom Search API Test FAILED:', error.message);
         if (error.response) {
             console.error('Details:', error.response.status, error.response.data?.error?.message || JSON.stringify(error.response.data));
         }
        return false;
    }
};

// Run tests
(async () => {
  console.log('--- Starting API Key Tests ---');
  await testOpenAI();
  console.log('---');
  await testSupabase();
  console.log('---');
  // --- IMPORTANT ---
  // Before running, check the `testGoogleNews` function above.
  // If you are testing the Google Custom Search API, you MUST uncomment the `cx` parameter
  // line and insert your Custom Search Engine ID (cx).
  // If your key is for a *different* Google API, you need to adjust the API_ENDPOINT and params.
  // --- --- --- ---
  await testGoogleNews();
  console.log('--- Tests Complete ---');
})(); 