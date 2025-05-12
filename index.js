require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors'); // Require the cors middleware
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios'); // Keep this for Google Search
const cron = require('node-cron'); // Keep this for scheduling

const app = express();
const port = process.env.PORT || 3001; // Use environment variable for port or default

// --- Middleware ---
// Enable CORS for all origins during development
// TODO: Restrict origins in production for security
app.use(cors()); 
app.use(express.json()); // Middleware to parse JSON bodies

// --- Initialize Clients ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; 

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env file');
  process.exit(1); // Exit if essential Supabase keys are missing
}
const supabase = createClient(supabaseUrl, supabaseServiceKey);
console.log('Supabase client initialized.');

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY missing in .env file');
  process.exit(1); // Exit if essential OpenAI key is missing
}
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
console.log('OpenAI client initialized.');

// --- API Endpoints ---

// Basic check endpoint
app.get('/', (req, res) => {
  res.send('Microplastics Pulse Backend is running!');
});

/**
 * Endpoint to manually add a single news article URL.
 * Expects POST request with JSON body: { "url": "article_url_here" }
 */
app.post('/api/add-news', async (req, res) => {
  const { url } = req.body;

  // Basic URL validation
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid or missing URL.' });
  }

  try {
    // 1. Check if URL already exists in DB
    console.log(`Checking DB for URL: ${url}`);
    const { data: existingArticle, error: checkError } = await supabase
      .from('latest_news')
      .select('url')
      .eq('url', url)
      .maybeSingle(); // Returns one or null

    if (checkError) {
      console.error('Error checking Supabase for existing URL:', checkError);
      return res.status(500).json({ error: 'Database error checking URL.' });
    }

    if (existingArticle) {
      console.log('URL already exists in the database.');
      return res.status(409).json({ message: 'URL already exists.' }); // 409 Conflict
    }

    // 2. Fetch title/snippet using Google Search for the specific URL
    console.log(`Fetching metadata for URL via Google: ${url}`);
    // We search for the URL itself to get Google's indexed title/snippet
    const searchResults = await fetchArticlesFromGoogle(url, 1); 

    if (!searchResults || searchResults.length === 0 || !searchResults[0].link.includes(url)) {
        // If Google didn't return the exact URL we searched for, we can't proceed reliably
        console.warn(`Could not reliably fetch metadata for ${url} via Google Search.`);
        // Optional: Save anyway with null summary/category, or return error?
        // Let's return an error for now, requiring metadata for AI processing.
         return res.status(404).json({ error: 'Could not retrieve article metadata via Google Search.' });
    }

    const articleData = searchResults[0]; // { title, link, snippet }
    console.log(`Retrieved metadata: Title - ${articleData.title}`);

    // 3. Process with OpenAI
    const ai_summary = await summarizeText(articleData.title, articleData.snippet);

    // 4. Save to Supabase
    const newItem = {
      url: url, // Use the original submitted URL
      title: articleData.title,
      ai_summary: ai_summary,
      source: new URL(url).hostname, // Extract hostname as source
      processed_at: new Date().toISOString(),
      // published_date would ideally come from Google Search or scraping, add later if possible
    };

    console.log('Attempting to insert new item into Supabase:', JSON.stringify(newItem, null, 2)); 

    // Remove .select() and just check the error
    const { error: insertError } = await supabase
      .from('latest_news')
      .insert(newItem);
       // .select(); // <-- REMOVED

    if (insertError) {
      console.error('!!! Supabase Insert Error Occurred:', insertError);
      if (insertError.code === '23505') { // Postgres unique violation code
           console.warn(`Insert failed due to duplicate URL (error code 23505): ${url}`);
           return res.status(409).json({ message: 'URL already exists (detected during insert).' });
      } else {
          return res.status(500).json({ error: 'Database error saving article.', details: insertError.message });
      }
    } else {
      // If no error, assume success for now, but acknowledge we didn't get data back
      console.log('Supabase Insert Reported No Error.'); 
      console.log(`Successfully processed article: ${url}`);
      // Can't return insertedData[0] anymore
      return res.status(201).json({ message: 'Article processed successfully (insert reported no error).', data: newItem }); 
    }

  } catch (error) {
    console.error('Unexpected error in /api/add-news:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Central Processing Logic ---
/**
 * Fetches articles for a given query, processes new ones, and saves to DB.
 * @param {string} query The search query.
 * @returns {Promise<number>} The number of new articles successfully added.
 */
async function processQueryAndSave(query) {
  let newArticlesAdded = 0;
  console.log(`--- Starting processing for query: "${query}" ---`);

  const articles = await fetchArticlesFromGoogle(query, 10); // Fetch top 10 results

  if (!articles || articles.length === 0) {
    console.log(`No articles found for query: "${query}"`);
    return 0;
  }

  // Get all existing URLs from DB once for efficiency
  const { data: existingUrlsData, error: urlFetchError } = await supabase
    .from('latest_news')
    .select('url');

  if (urlFetchError) {
      console.error('Error fetching existing URLs from Supabase:', urlFetchError);
      // Decide if we should stop or continue without checking duplicates
      // Let's stop for now to avoid potential duplicate processing errors
      return 0;
  }
  const existingUrls = new Set(existingUrlsData.map(item => item.url));
  console.log(`Found ${existingUrls.size} existing URLs in DB.`);

  for (const article of articles) {
    const { title, link: url, snippet } = article; // Use 'link' as the url

    // Basic validation
    if (!url || !title || !url.startsWith('http')) {
      console.warn('Skipping article with missing URL or title:', article);
      continue;
    }

    // Check if URL already exists (using the Set for quick lookup)
    if (existingUrls.has(url)) {
      // console.log(`URL already exists, skipping: ${url}`);
      continue;
    }

    console.log(`Processing NEW article: ${title} (${url})`);

    // Process with OpenAI
    const ai_summary = await summarizeText(title, snippet);

    // Prepare item for DB
    const newItem = {
      url: url,
      title: title,
      ai_summary: ai_summary,
      source: new URL(url).hostname, 
      processed_at: new Date().toISOString(),
      // published_date could be added here if fetchArticlesFromGoogle provides it
    };

    // Save to Supabase
    const { error: insertError } = await supabase
      .from('latest_news')
      .insert(newItem);

    if (insertError) {
      // Handle potential duplicate URL error during insert gracefully
      if (insertError.code === '23505') { // Postgres unique violation code
           console.warn(`Attempted to insert duplicate URL (race condition?): ${url}`);
      } else {
          console.error(`Error inserting data into Supabase for ${url}:`, insertError);
      }
    } else {
      console.log(`Successfully added: ${title}`);
      newArticlesAdded++;
      existingUrls.add(url); // Add to set to prevent re-processing in this run
    }
    
    // Optional: Add a small delay between processing articles to avoid rate limits?
    // await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 second delay
  }

  console.log(`--- Finished processing for query: "${query}". Added ${newArticlesAdded} new articles. ---`);
  return newArticlesAdded;
}

/**
 * Endpoint to manually trigger a fetch cycle for predefined queries.
 */
app.post('/api/trigger-fetch', async (req, res) => {
  console.log('Manual fetch triggered via API.');
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
  let errorsOccurred = false;

  try {
    // Process queries sequentially to avoid overwhelming APIs (can be parallelized carefully later)
    for (const query of searchQueries) {
      const addedCount = await processQueryAndSave(query);
      totalAdded += addedCount;
    }
    console.log(`Manual fetch completed. Total new articles added: ${totalAdded}`);
    res.status(200).json({ message: 'Fetch cycle completed.', newArticlesAdded: totalAdded });
  } catch (error) {
    console.error('Error during manual fetch cycle:', error);
    res.status(500).json({ error: 'An error occurred during the fetch cycle.' });
  }
});

// --- Scheduled Tasks ---
// TODO: Update cron job to call processQueryAndSave for each query
// cron.schedule('0 */8 * * *', async () => { // Example: Run every 8 hours
//   console.log('Running scheduled task: Fetching latest news...');
//   const searchQueries = [
//     "latest research microplastics human health site:nature.com OR site:sciencedirect.com",
//     "global microplastic pollution report 2025 site:who.int OR site:unep.org",
//     "microplastics ubiquity environment food chain site:nature.com",
//     "emerging health concerns microplastics 2025 site:thelancet.com OR site:nih.gov",
//     "policy innovation to prevent microplastic contamination 2025",
//     "how microplastics enter the human body ingestion inhalation dermal site:ncbi.nlm.nih.gov",
//     "bioaccumulation of microplastics in human organs site:sciencedirect.com",
//     "crossing blood brain barrier microplastics placenta gut brain site:nature.com",
//     "translocation of microplastics to brain or placenta site:cell.com",
//     "microplastics inflammation oxidative stress endocrine disruption site:ncbi.nlm.nih.gov",
//     "microplastics gut microbiome dysbiosis immunity site:gut.bmj.com OR site:nature.com",
//     "microplastics reproductive health fetal exposure site:thelancet.com",
//     "microplastics impact on brain neurological disorders site:sciencedirect.com",
//     "microplastics and chronic disease cancer diabetes cardiovascular site:who.int",
//     "microplastics linked to erectile dysfunction antibiotic resistance superbugs",
//     "food contamination microplastics seafood produce packaging site:efsa.europa.eu",
//     "airborne microplastics indoor exposure site:epa.gov OR site:pubmed.ncbi.nlm.nih.gov",
//     "textiles cosmetics furniture microplastic emissions site:echa.europa.eu",
//     "wellness industry microplastics awareness detox contradictions site:gwi.org",
//     "clean living vs microplastic reality wellness narrative site:mindbodygreen.com OR site:wellandgood.com",
//     "microplastics detox evidence probiotics antioxidants site:ncbi.nlm.nih.gov",
//     "individual microplastic exposure reduction tips 2025 site:cdc.gov OR site:who.int",
//     "new technologies microplastic removal blood purification 2025",
//     "probiotic and antioxidant strategies microplastic detox site:sciencedirect.com",
//     "wellness program standards to reduce microplastic exposure site:spaindustry.org",
//     "2025 microplastic research priorities wellness industry site:gwi.org OR site:nih.gov",
//     "call to action microplastics wellness sustainability site:globalwellnesssummit.com",
//     "research gaps in microplastic and human health site:thelancet.com OR site:who.int"
//   ]; 
//   for (const query of searchQueries) {
//      await processQueryAndSave(query);
//   }
//   console.log('Scheduled task finished.');
// });

// --- Helper Functions ---

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
    return []; // Return empty array if keys are missing
  }

  const params = {
    key: apiKey,
    cx: cxId,
    q: query,
    num: numResults,
    // Optional: Add more parameters like `dateRestrict` or `sort` if needed
    // dateRestrict: 'd[7]' // Example: Restrict to last 7 days
    // sort: 'date' // Example: Sort by date
  };

  try {
    console.log(`Fetching Google Custom Search results for query: "${query}"`);
    const response = await axios.get(apiUrl, { params });

    if (response.data && response.data.items) {
      // Map results to a cleaner format
      const articles = response.data.items.map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        // Add other fields if available and useful, e.g., item.pagemap?.metatags?.[0]?.[ 'article:published_time']
      }));
      console.log(`Found ${articles.length} results from Google.`);
      return articles;
    } else {
      console.log('No items found in Google Custom Search response.');
      return [];
    }
  } catch (error) {
    console.error('Error fetching from Google Custom Search API:', error.response ? `${error.message} - Status: ${error.response.status}` : error.message);
    if (error.response && error.response.data) {
        console.error('Google API Error Details:', error.response.data.error?.message || JSON.stringify(error.response.data));
    }
    return []; // Return empty array on error
  }
}

/**
 * Generates a brief summary using OpenAI.
 * @param {string} title The article title.
 * @param {string} snippet The article snippet/description.
 * @returns {Promise<string|null>} The generated summary or null on error.
 */
async function summarizeText(title, snippet) {
  if (!title || !snippet) return null;
  // Updated prompt for longer summary
  const prompt = `Summarize the key points of an article titled "${title}" with the following description: "${snippet}". Respond with only the summary, in up to four sentences, providing a bit more depth.`;
  try {
    console.log(`Requesting summary for: "${title}"`);
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120, // Increased max_tokens for longer summary
      temperature: 0.5,
      n: 1,
    });
    const summary = completion.choices[0]?.message?.content?.trim();
    console.log(`Generated summary: ${summary}`);
    return summary || null;
  } catch (error) {
    console.error('Error generating summary with OpenAI:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
    return null;
  }
}

// --- Server Start ---
app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
});

// --- Helper Functions (Example Structure) ---
// async function fetchNewsAndProcess() {
//   try {
//     // 1. Fetch from Google News API
//     // const articles = await fetchFromGoogleNews();
//     
//     // 2. Filter out existing articles (check Supabase)
//     // const newArticles = await filterExistingArticles(articles);
//     
//     // 3. For each new article:
//     // for (const article of newArticles) {
//     //   //  a. Fetch content (carefully - maybe just use API summary if available)
//     //   //  b. Summarize with OpenAI
//     //   //  c. Categorize with OpenAI
//     //   //  d. Store in Supabase
//     // }
// 
//     // console.log('News processing complete.');
// 
//   // } catch (error) {
//   //   console.error('Error during scheduled news fetch:', error);
//   // }
// }

// Other helper functions: fetchFromGoogleNews, filterExistingArticles, summarizeWithOpenAI, etc.