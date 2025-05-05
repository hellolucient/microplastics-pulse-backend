require('dotenv').config(); 
const express = require('express');
// const cors = require('cors'); // <-- Remove require
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');
// const cron = require('node-cron'); // Removed for Vercel Serverless

const app = express();
// const port = process.env.PORT || 3001; // Port is handled by Vercel

// --- Middleware ---
// Remove CORS middleware setup
// const corsOptions = {
//   origin: 'http://localhost:5173', 
//   optionsSuccessStatus: 200 
// };
// app.use(cors(corsOptions)); 
app.use(express.json()); 

// --- Initialize Clients ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; 
let supabase;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('Supabase client initialized.');
} else {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_KEY missing.');
  // Don't exit process in serverless, just log
}

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log('OpenAI client initialized.');
} else {
   console.error('Error: OPENAI_API_KEY missing.');
}

// --- Whitepaper chapter titles ---
const chapterTitles = [
  "Chapter 1: Microplastics and Human Health – Introduction",
  // ... (rest of chapter titles) ...
  "Chapter 7: Conclusion and Future Directions",
];

// --- Helper Functions (fetchArticlesFromGoogle, summarizeText, categorizeText) ---
// Assume these functions exist here (copied/required from previous index.js)
// Make sure they handle potential null clients (supabase, openai)

/**
 * Fetches search results from Google Custom Search API.
 * @param {string} query The search query (e.g., "microplastic health effects").
 * @param {number} numResults The number of results to request (default: 10).
 * @returns {Promise<Array<{title: string, link: string, snippet: string}>>} A list of search results.
 */
async function fetchArticlesFromGoogle(query, numResults = 10) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cxId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    const apiUrl = "https://www.googleapis.com/customsearch/v1";

    if (!apiKey || !cxId) {
        console.error("Google API Key or CX ID is missing.");
        return [];
    }
    const params = { key: apiKey, cx: cxId, q: query, num: numResults };

    try {
        console.log(`Fetching Google results for query: "${query}"`);
        const response = await axios.get(apiUrl, { params });
        if (response.data && response.data.items) {
            const articles = response.data.items.map(item => ({ title: item.title, link: item.link, snippet: item.snippet }));
            console.log(`Found ${articles.length} results from Google.`);
            return articles;
        } else {
            console.log('No items found in Google response.');
            return [];
        }
    } catch (error) {
        console.error('Error fetching from Google Custom Search:', error.response ? `${error.message} - Status: ${error.response.status}` : error.message);
        if (error.response && error.response.data) console.error('Google API Error Details:', error.response.data.error?.message || JSON.stringify(error.response.data));
        return [];
    }
}

/**
 * Generates a brief summary using OpenAI.
 */
async function summarizeText(title, snippet) {
    if (!openai || !title || !snippet) return null;
    const prompt = `Summarize the key point of an article titled "${title}" with description: "${snippet}". Respond concisely in one or two sentences.`;
    try {
        console.log(`Requesting summary for: "${title}"`);
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], max_tokens: 60, temperature: 0.5, n: 1,
        });
        const summary = completion.choices[0]?.message?.content?.trim();
        console.log(`Generated summary: ${summary}`);
        return summary || null;
    } catch (error) {
        console.error('Error generating summary with OpenAI:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
        return null;
    }
}

/**
 * Suggests a relevant whitepaper chapter category using OpenAI.
 */
async function categorizeText(title, snippet) {
    if (!openai || !title || !snippet) return null;
    const chapterList = chapterTitles.join("\n - ");
    const prompt = `Given chapters:
 - ${chapterList}

Which chapter is MOST relevant to article "${title}" with description: "${snippet}"? Respond ONLY with the exact chapter title.`;
    try {
        console.log(`Requesting category for: "${title}"`);
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], max_tokens: 50, temperature: 0.2, n: 1,
        });
        let category = completion.choices[0]?.message?.content?.trim();
        if (category && chapterTitles.includes(category)) {
            console.log(`Suggested category: ${category}`);
            return category;
        } else {
            console.warn(`OpenAI category response ("${category}") invalid. Defaulting to null.`);
            return null;
        }
    } catch (error) {
        console.error('Error generating category with OpenAI:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
        return null;
    }
}


// --- Central Processing Logic (processQueryAndSave) ---
// Assume this function exists here (copied/required from previous index.js)
// Make sure it handles potential null supabase client
/**
 * Fetches articles for a given query, processes new ones, and saves to DB.
 */
async function processQueryAndSave(query) {
    if (!supabase) {
        console.error("processQueryAndSave: Supabase client not available.");
        return 0;
    }
    let newArticlesAdded = 0;
    console.log(`--- Starting processing for query: "${query}" ---`);
    const articles = await fetchArticlesFromGoogle(query, 10);
    if (!articles || articles.length === 0) return 0;

    const { data: existingUrlsData, error: urlFetchError } = await supabase.from('latest_news').select('url');
    if (urlFetchError) {
        console.error('Error fetching existing URLs:', urlFetchError);
        return 0;
    }
    const existingUrls = new Set(existingUrlsData.map(item => item.url));
    console.log(`Found ${existingUrls.size} existing URLs.`);

    for (const article of articles) {
        const { title, link: url, snippet } = article;
        if (!url || !title || !url.startsWith('http') || existingUrls.has(url)) continue;

        console.log(`Processing NEW article: ${title} (${url})`);
        const ai_summary = await summarizeText(title, snippet);
        const ai_category = await categorizeText(title, snippet);
        const newItem = { url, title, ai_summary, ai_category, source: new URL(url).hostname, processed_at: new Date().toISOString() };

        const { error: insertError } = await supabase.from('latest_news').insert(newItem);
        if (insertError) {
            if (insertError.code === '23505') console.warn(`Duplicate URL during insert: ${url}`);
            else console.error(`Insert error for ${url}:`, insertError);
        } else {
            console.log(`Successfully added: ${title}`);
            newArticlesAdded++;
            existingUrls.add(url);
        }
        // Optional delay
    }
    console.log(`--- Finished query: "${query}". Added ${newArticlesAdded} new. ---`);
    return newArticlesAdded;
}


// --- API Endpoints ---

// Basic check endpoint (optional, good for testing deployment)
app.get('/api', (req, res) => {
  res.send('Microplastics Pulse Backend API is running!');
});

// Manual Add Endpoint
app.post('/api/add-news', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid or missing URL.' });
  }
  try {
    const { data: existingArticle, error: checkError } = await supabase.from('latest_news').select('url').eq('url', url).maybeSingle();
    if (checkError) throw checkError;
    if (existingArticle) return res.status(409).json({ message: 'URL already exists.' });

    const searchResults = await fetchArticlesFromGoogle(url, 1);
    if (!searchResults || searchResults.length === 0 || !searchResults[0].link.includes(url)) {
         return res.status(404).json({ error: 'Could not retrieve article metadata via Google Search.' });
    }
    const articleData = searchResults[0];
    const ai_summary = await summarizeText(articleData.title, articleData.snippet);
    const ai_category = await categorizeText(articleData.title, articleData.snippet);
    const newItem = { url, title: articleData.title, ai_summary, ai_category, source: new URL(url).hostname, processed_at: new Date().toISOString() };

    console.log('Attempting manual insert:', JSON.stringify(newItem, null, 2));
    const { error: insertError } = await supabase.from('latest_news').insert(newItem);
    if (insertError) throw insertError;

    console.log('Manual insert successful.');
    return res.status(201).json({ message: 'Article processed successfully.', data: newItem });
  } catch (error) {
    console.error('Error in /api/add-news:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'URL already exists.'});
    return res.status(500).json({ error: 'Internal server error processing URL.', details: error.message });
  }
});

// Scheduled Fetch Endpoint (for Vercel Cron)
app.get('/api/scheduled-fetch', async (req, res) => {
  // Optional: Add security check (e.g., check for a secret header/token)
  // if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).send('Unauthorized');
  // }
  console.log('Scheduled fetch triggered via API.');
  const searchQueries = [
      "latest research microplastics human health site:nature.com OR site:sciencedirect.com",
      "global microplastic pollution report 2025 site:who.int OR site:unep.org",
      "microplastics ubiquity environment food chain site:nature.com",
      "emerging health concerns microplastics 2025 site:thelancet.com OR site:nih.gov",
      "policy innovation to prevent microplastic contamination 2025",
      "how microplastics enter the human body ingestion inhalation dermal site:ncbi.nlm.nih.gov",
      "bioaccumulation of microplastics in human organs site:sciencedirect.com",
      "crossing blood brain barrier microplastics placenta gut brain site:nature.com",
      "translocation of microplastics to brain or placenta site:cell.com",
      "microplastics inflammation oxidative stress endocrine disruption site:ncbi.nlm.nih.gov",
      "microplastics gut microbiome dysbiosis immunity site:gut.bmj.com OR site:nature.com",
      "microplastics reproductive health fetal exposure site:thelancet.com",
      "microplastics impact on brain neurological disorders site:sciencedirect.com",
      "microplastics and chronic disease cancer diabetes cardiovascular site:who.int",
      "microplastics linked to erectile dysfunction antibiotic resistance superbugs",
      "food contamination microplastics seafood produce packaging site:efsa.europa.eu",
      "airborne microplastics indoor exposure site:epa.gov OR site:pubmed.ncbi.nlm.nih.gov",
      "textiles cosmetics furniture microplastic emissions site:echa.europa.eu",
      "wellness industry microplastics awareness detox contradictions site:gwi.org",
      "clean living vs microplastic reality wellness narrative site:mindbodygreen.com OR site:wellandgood.com",
      "microplastics detox evidence probiotics antioxidants site:ncbi.nlm.nih.gov",
      "individual microplastic exposure reduction tips 2025 site:cdc.gov OR site:who.int",
      "new technologies microplastic removal blood purification 2025",
      "probiotic and antioxidant strategies microplastic detox site:sciencedirect.com",
      "wellness program standards to reduce microplastic exposure site:spaindustry.org",
      "2025 microplastic research priorities wellness industry site:gwi.org OR site:nih.gov",
      "call to action microplastics wellness sustainability site:globalwellnesssummit.com",
      "research gaps in microplastic and human health site:thelancet.com OR site:who.int"
  ];
  let totalAdded = 0;
  try {
    for (const query of searchQueries) {
      const addedCount = await processQueryAndSave(query);
      totalAdded += addedCount;
    }
    console.log(`Scheduled fetch completed. Total new articles added: ${totalAdded}`);
    res.status(200).json({ message: 'Scheduled fetch cycle completed.', newArticlesAdded: totalAdded });
  } catch (error) {
    console.error('Error during scheduled fetch cycle:', error);
    res.status(500).json({ error: 'An error occurred during the scheduled fetch cycle.' });
  }
});

// Manual Trigger Fetch Endpoint (for Frontend Button)
app.post('/api/trigger-fetch', async (req, res) => {
  console.log('Manual fetch triggered via POST API.'); // Log manual trigger
  const searchQueries = [
      "latest research microplastics human health site:nature.com OR site:sciencedirect.com",
      // ... (full list of search queries) ...
      "research gaps in microplastic and human health site:thelancet.com OR site:who.int"
  ];
  let totalAdded = 0;
  try {
    for (const query of searchQueries) {
      // Re-use the same processing logic
      const addedCount = await processQueryAndSave(query);
      totalAdded += addedCount;
    }
    console.log(`Manual fetch completed. Total new articles added: ${totalAdded}`);
    res.status(200).json({ message: 'Manual fetch cycle completed.', newArticlesAdded: totalAdded });
  } catch (error) {
    console.error('Error during manual fetch cycle:', error);
    res.status(500).json({ error: 'An error occurred during the manual fetch cycle.' });
  }
});


// --- Remove Server Start ---
// app.listen(port, () => {
//   console.log(`Backend server listening on port ${port}`);
// });

// Export the Express API
module.exports = app; 