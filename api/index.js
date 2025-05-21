require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');
const { put } = require('@vercel/blob'); // Added Vercel Blob import
const cheerio = require('cheerio'); // Added Cheerio
const he = require('he'); // Added he library
// const cron = require('node-cron'); // Removed for Vercel Serverless

const app = express();
// const port = process.env.PORT || 3001; // Port is handled by Vercel

// --- Middleware ---
app.use(express.json()); 

const allowedOrigins = [
  'https://microplastics-pulse.vercel.app', // Your original Vercel frontend URL
  'https://www.microplasticswatch.com',    // Your new custom domain
  'http://localhost:3000',                 // For local development (React default)
  'http://localhost:5173',                 // For local development (Vite default)
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not ' +
                  'allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

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

// --- Helper Functions (fetchArticlesFromGoogle, summarizeText, categorizeText) ---
// Assume these functions exist here (copied/required from previous index.js)
// Make sure they handle potential null clients (supabase, openai)

/**
 * Fetches search results from Google Custom Search API.
 * @param {string} query The search query (e.g., "microplastic health effects").
 * @param {number} numResults The number of results to request (default: 10).
 * @returns {Promise<{success: boolean, articles?: Array<{title: string, link: string, snippet: string}>, error?: {status?: number, message: string}}>}
 *          An object indicating success or failure.
 *          On success, includes the 'articles' array (might be empty).
 *          On failure, includes the 'error' object with status and message.
 */
async function fetchArticlesFromGoogle(query, numResults = 10) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cxId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    const apiUrl = "https://www.googleapis.com/customsearch/v1";

    if (!apiKey || !cxId) {
        const errorMsg = "Google API Key or CX ID is missing.";
        console.error(errorMsg);
        // Return failure object
        return { success: false, error: { message: errorMsg } };
    }
    const params = { key: apiKey, cx: cxId, q: query, num: numResults };

    try {
        console.log(`Fetching Google results for query: "${query}"`);
        const response = await axios.get(apiUrl, { params, timeout: 25000 }); // 25 seconds timeout
        if (response.data && response.data.items) {
            const articles = response.data.items.map(item => ({ title: item.title, link: item.link, snippet: item.snippet }));
            console.log(`Found ${articles.length} results from Google.`);
            // Return success object with articles
            return { success: true, articles: articles };
        } else {
            console.log('No items found in Google response.');
            // Return success object with empty articles array
            return { success: true, articles: [] };
        }
    } catch (error) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.error?.message || error.message;
        
        if (error.code === 'ECONNABORTED') {
            console.error(`Google API call timed out for query: "${query}" after 25 seconds.`);
            return { success: false, error: { status: 'TIMEOUT', message: 'Google API call timed out.' } };
        }
        
        console.error('Error fetching from Google Custom Search:', error.response ? `${error.message} - Status: ${status}` : error.message);
        if (error.response && error.response.data) console.error('Google API Error Details:', errorMessage);
        // Return failure object with error details
        return { success: false, error: { status: status, message: errorMessage } };
    }
}

/**
 * Generates a detailed summary of the article using OpenAI.
 */
async function summarizeText(title, snippet) {
    if (!openai || !title || !snippet) return null;
    const prompt = `Generate a detailed summary of the article titled "${title}" with the provided snippet: "${snippet}". The summary should be comprehensive, approximately 6-8 sentences long (around 150-200 words). It must capture the main topics and key findings. Crucially, ensure the summary includes specific examples, important terms, likely key search terms, mentions of product types (e.g., water bottles, food packaging), and relevant category mentions (e.g., health impacts, environmental sources) if present in the article. The primary goal is to provide enough detail to significantly improve searchability for these specific keywords and concepts within the article's content. Respond with only the summary.`;
    try {
        console.log(`Requesting detailed summary for: "${title}"`);
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", 
            messages: [{ role: "user", content: prompt }], 
            max_tokens: 250, // Increased max_tokens for more detailed summary
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

/**
 * Generates an image using OpenAI DALL-E, uploads it to Vercel Blob, and returns the Blob URL.
 * @param {string} title The article title to use for the image prompt.
 * @param {string} articleUrl The URL of the article, used for generating a unique filename.
 * @returns {Promise<string|null>} The Vercel Blob URL of the stored image, or null on failure.
 */
async function generateAndStoreImage(title, articleUrl) {
    console.log(`[generateAndStoreImage CALLED] Title: ${title}, URL: ${articleUrl}`);
    if (!openai) {
        console.error("generateAndStoreImage: OpenAI client not available.");
        return null;
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        console.warn("generateAndStoreImage: BLOB_READ_WRITE_TOKEN is not set. Skipping image generation.");
        return null;
    }
    if (!title || !articleUrl) {
        console.error("generateAndStoreImage: Missing title or articleUrl.");
        return null;
    }

    const new_prompt = `Generate a realistic, editorial-style photo illustration for an article titled \"${title.substring(0, 150)}\". The image must visually communicate the article's core theme using real-world elements, settings, or symbolic objects. **Absolutely no text, letters, words, or numbers should appear anywhere in the image.** If people are depicted, their expressions should be neutral or show subtle concern, reflecting a serious tone without being overly dramatic, distressed, or despairing. Critically, people should not be smiling or appear happy. The overall style must be grounded and avoid surreal or exaggerated elements. Use cinematic lighting or natural daylight appropriate to the article's mood. Ensure no watermarks or logos are present.`;
    const prompt = new_prompt;
    let tempImageUrl;

    try {
        console.log(`Requesting DALL-E image for: "${title}" with new prompt.`);
        const imageResponsePromise = openai.images.generate({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            response_format: "url",
            quality: "standard",
            style: "natural"
        });
        
        // Timeout for DALL-E image generation (e.g., 120 seconds)
        const imageResponse = await Promise.race([
            imageResponsePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('DALL-E image generation timed out after 120 seconds')), 120000))
        ]);

        tempImageUrl = imageResponse.data?.[0]?.url;
        if (!tempImageUrl) {
            console.error("DALL-E did not return an image URL or timed out.");
            return null;
        }
        console.log(`DALL-E temporary image URL: ${tempImageUrl}`);

        // Fetch the image data from the temporary URL with timeout (e.g., 30 seconds)
        const imageBufferResponsePromise = axios.get(tempImageUrl, { 
            responseType: 'arraybuffer', 
        });
        const imageBufferResponse = await Promise.race([
            imageBufferResponsePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fetching image data from DALL-E URL timed out after 30 seconds')), 30000))
        ]);
        
        const imageBuffer = imageBufferResponse.data;

        if (!imageBuffer) {
            console.error("Failed to fetch image data from DALL-E URL or timed out.");
            return null;
        }

        const sanitizedUrlPart = articleUrl.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
        const filename = `article-images/${sanitizedUrlPart}-${Date.now()}.png`;

        console.log(`Uploading image to Vercel Blob as: ${filename}`);
        // Timeout for Vercel Blob upload (e.g., 30 seconds)
        const blobPromise = put(filename, imageBuffer, {
            access: 'public',
            contentType: 'image/png',
            addRandomSuffix: false,
            token: process.env.BLOB_READ_WRITE_TOKEN // Explicitly pass the token
        });
        const blob = await Promise.race([
            blobPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Vercel Blob upload timed out after 30 seconds')), 30000))
        ]);

        console.log(`Image successfully uploaded to Vercel Blob: ${blob.url}`);
        return blob.url;

    } catch (error) {
        console.error('Error or timeout in generateAndStoreImage:', error.message);
        if (error.response?.data?.error?.code === 'billing_hard_limit_reached') {
            console.error("OpenAI DALL-E request failed: Billing hard limit reached. Cannot generate image.");
        } else if (error.message && (error.message.includes('timed out') || error.code === 'ECONNABORTED' || error.code === 'ECONNRESET')) {
            console.warn(`A timeout occurred during image generation/storage for "${title}": ${error.message}`);
        } else if (error.response) { // Log Axios error details if available
            console.error(`Error details from API call: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        }        
        return null; // Ensure null is returned on any error/timeout to allow main loop to continue
    }
}

// Helper function to fetch and parse article details (title, snippet)
async function fetchArticleDetails(articleUrl) {
    const isXUrl = articleUrl.includes('x.com') || articleUrl.includes('twitter.com');

    if (isXUrl) {
        console.log(`[X.com Handling] Bypassing direct fetch for X/Twitter URL: ${articleUrl}. Returning generic info.`);
        let title = 'Post on X';
        try {
            const pathParts = new URL(articleUrl).pathname.split('/');
            const username = pathParts[1];
            if (username && username.toLowerCase() !== 'i' && username.toLowerCase() !== 'home' && !username.includes('.')) {
                title = `Post on X by ${username}`;
            }
        } catch (e) {
            console.warn(`[X.com Handling] Could not parse username from URL ${articleUrl} for title.`);
        }
        return { title: he.decode(title), snippet: null }; // Ensure title is decoded, snippet is null
    }

    // Proceed with fetching for non-X.com URLs
    try {
        console.log(`Fetching article details for URL: ${articleUrl}`);
        const AXIOS_TIMEOUT = 30000;
        
        let axiosConfig = {
            timeout: AXIOS_TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        };
        // Removed Googlebot UA logic as it caused 403 for X and is not needed if we bypass fetch for X

        const { data: htmlContent } = await axios.get(articleUrl, axiosConfig);
        const $ = cheerio.load(htmlContent);

        let title; 
        let snippet;

        // Specific handling for LinkedIn (example, can be expanded)
        if (articleUrl.includes('linkedin.com')) { 
            title = $('meta[property="og:title"]').attr('content') || $('title').first().text();
            if (title) title = he.decode(title.trim());

            snippet = $('meta[property="og:description"]').attr('content');
            if (snippet) {
                snippet = he.decode(snippet.trim());
            } else {
                 console.warn(`Could not extract og:description for LinkedIn URL: ${articleUrl}. Attempting generic paragraph.`);
                 let pText = $('p').first().text(); 
                 if (pText) snippet = he.decode(pText.trim()).substring(0,500);
            }
        } else { // Generic handling for other (non-X, non-LinkedIn initially) URLs
            title = $('meta[property="og:title"]').attr('content') || $('title').first().text();
            if (title) title = he.decode(title.trim());

            snippet = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content');
            if (snippet) snippet = he.decode(snippet.trim());
        }

        // Fallbacks if title/snippet are still missing (for non-X URLs)
        if (!title) {
            console.warn(`Could not extract title for ${articleUrl}`);
            try {
                title = `Article from ${new URL(articleUrl).hostname}`;
            } catch (e) {
                title = `Article from URL`;
            }
        }

        if (!snippet) { 
            console.warn(`Could not extract meta description for ${articleUrl}. Using first paragraph as fallback.`);
            let pText = $('p').first().text();
            if (pText) snippet = he.decode(pText.trim()).substring(0, 500);
            
            if (!snippet) {
                 console.warn(`Could not extract first paragraph for ${articleUrl}. Snippet will be empty.`);
                 snippet = ''; 
            }
        }
        
        if (snippet && snippet.length > 600) { 
            snippet = snippet.substring(0, 597) + "...";
        }

        if (snippet === null) {
             console.log(`[fetchArticleDetails] Snippet is intentionally null for ${articleUrl}`);
        } else if (!snippet) {
            snippet = '';
        }

        console.log(`Extracted Title: ${title}, Snippet: ${snippet === null ? '[NULL]' : snippet.substring(0,100)+'...'} (Length: ${snippet === null ? 0 : snippet.length})`);
        return { title, snippet };

    } catch (error) {
        console.error(`Error fetching article details for ${articleUrl}:`, error.message);
        let hostname = 'unknown source';
        try {
            hostname = new URL(articleUrl).hostname;
        } catch (e) { /* ignore */ }
        // Return a specific error message that can be checked by the caller if needed
        return { title: `Article from ${hostname}`, snippet: 'Could not fetch content. The source may be dynamic or protected.'}; 
    }
}

// --- Central Processing Logic (processQueryAndSave) ---
/**
 * Fetches articles for a given query, processes new ones, and saves to DB.
 * @returns {Promise<{status: string, count: number}>} An object indicating the outcome:
 *          - status: 'success', 'quota_error', 'google_api_error', 'db_error', 'no_client_error', 'google_timeout_error'
 *          - count: Number of articles added (only relevant on 'success')
 */
async function processQueryAndSave(query) {
    if (!supabase) {
        console.error("processQueryAndSave: Supabase client not available.");
        return { status: 'db_error', count: 0 };
    }
    let newArticlesAdded = 0;
    console.log(`--- Starting processing for query: "${query}" ---`);

    // Fetch from Google
    const googleResponse = await fetchArticlesFromGoogle(query, 10);

    // Handle Google API call failure
    if (!googleResponse.success) {
        console.error(`Google Search API call failed for query "${query}":`, googleResponse.error);
        if (googleResponse.error?.status === 429) {
            console.warn(`Google Search API quota exceeded for query "${query}".`);
            return { status: 'quota_error', count: 0 }; // Specific status for quota
        } else if (googleResponse.error?.status === 'TIMEOUT') {
            console.warn(`Google Search API call timed out for query "${query}".`);
            return { status: 'google_timeout_error', count: 0 };
        } else {
            // Other Google API errors
            return { status: 'google_api_error', count: 0 };
        }
    }

    const articles = googleResponse.articles;
    // Check if the successful API call returned any articles
    if (!articles || articles.length === 0) {
        console.log(`No articles found in Google response for query: "${query}"`);
        return { status: 'success', count: 0 }; // Success, but 0 articles found
    }

    // Fetch existing URLs from DB
    const { data: existingUrlsData, error: urlFetchError } = await supabase.from('latest_news').select('url');
    if (urlFetchError) {
        console.error(`Error fetching existing URLs for query "${query}":`, urlFetchError);
        return { status: 'db_error', count: 0 }; // DB error fetching URLs
    }
    const existingUrls = new Set(existingUrlsData.map(item => item.url));
    console.log(`Found ${existingUrls.size} existing URLs before processing query "${query}".`);

    // Process returned articles
    for (const article of articles) {
        const { title, link: url, snippet } = article;
        // Basic validation and duplicate check
        if (!url || !title || !url.startsWith('http') || existingUrls.has(url)) continue;

        console.log(`Processing NEW article from query "${query}": ${title} (${url})`);
        const ai_summary = await summarizeText(title, snippet);
        const ai_image_url = await generateAndStoreImage(title, url); // Generate and store image

        // Add basic error handling for URL parsing
        let sourceHostname;
        try {
            sourceHostname = new URL(url).hostname;
        } catch (e) {
            console.warn(`Invalid URL format encountered during processing: ${url}`);
            continue; // Skip this article if URL is invalid
        }

        const newItem = { url, title, ai_summary, ai_image_url, source: sourceHostname, processed_at: new Date().toISOString() };

        // Insert into DB
        const { error: insertError } = await supabase.from('latest_news').insert(newItem);
        if (insertError) {
            if (insertError.code === '23505') {
                console.warn(`Duplicate URL during insert (race condition?): ${url}`);
            } else {
                console.error(`Insert error for ${url} from query "${query}":`, insertError);
                // Note: We are currently *not* stopping the whole process for a single insert error.
                // If one insert fails, we log it and continue with the next article.
                // If we wanted to stop immediately on *any* DB error, we would return { status: 'db_error', count: newArticlesAdded } here.
            }
        } else {
            console.log(`Successfully added: ${title}`);
            newArticlesAdded++;
            existingUrls.add(url);
        }
    }
    console.log(`--- Finished query: "${query}". Added ${newArticlesAdded} new. ---`);
    // Return success status and the count of added articles
    return { status: 'success', count: newArticlesAdded };
}


// --- API Endpoints ---

// Basic check endpoint (optional, good for testing deployment)
app.get('/api', (req, res) => {
  res.send('Microplastics Pulse Backend API is running!');
});

// Manual Add Endpoint
app.post('/api/add-news', async (req, res) => {
  console.log('[/api/add-news ENDPOINT HIT] Request received.');
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid or missing URL.' });
  }
  try {
    // 1. Check DB
    const { data: existingArticle, error: checkError } = await supabase.from('latest_news').select('url').eq('url', url).maybeSingle();
    if (checkError) {
        console.error("Supabase check error:", checkError);
        throw checkError; // Let generic error handler catch DB issues
    }
    if (existingArticle) return res.status(409).json({ message: 'URL already exists.' });

    // 2. Fetch from Google
    const googleResponse = await fetchArticlesFromGoogle(url, 1);

    // Handle Google API call failure
    if (!googleResponse.success) {
        if (googleResponse.error?.status === 429) {
            console.warn('Google Search API quota exceeded.');
            return res.status(429).json({ error: 'Google Search API quota exceeded. Please try again later.', details: googleResponse.error.message });
        } else {
            console.error('Google Search API call failed:', googleResponse.error);
            return res.status(500).json({ error: 'Failed to communicate with Google Search API.', details: googleResponse.error?.message || 'Unknown API error' });
        }
    }

    // API call was successful, now validate results
    const searchResults = googleResponse.articles;

    // Validate Google Search results more flexibly by comparing hostnames
    let googleResultLink = null;
    if (searchResults && searchResults.length > 0 && searchResults[0].link) {
        googleResultLink = searchResults[0].link;
    }

    let originalUrlHostname = null;
    try {
        originalUrlHostname = new URL(url).hostname;
    } catch (e) {
        console.warn(`Invalid original URL format: ${url}`);
        return res.status(400).json({ error: 'Invalid URL format submitted.' });
    }

    let googleResultHostname = null;
    if (googleResultLink) {
        try {
            googleResultHostname = new URL(googleResultLink).hostname;
        } catch (e) {
            console.warn(`Invalid Google result URL format: ${googleResultLink}`);
            // Proceed without hostname check if Google's URL is weird, but log it
        }
    }

    // If we couldn't get a result from Google (empty array), or if the hostnames don't match, return 404
    // This now specifically means Google API worked, but didn't return a usable/matching result.
    if (!googleResultLink || (googleResultHostname && originalUrlHostname !== googleResultHostname)) {
         console.warn(`Google Search result validation failed (API OK, no matching result). Original URL: ${url}, Google URL: ${googleResultLink}, Original Host: ${originalUrlHostname}, Google Host: ${googleResultHostname}`);
         return res.status(404).json({ error: 'Could not retrieve matching article metadata via Google Search.' });
    }

    // 3. Process with AI and Save
    const articleData = searchResults[0];
    const sourceHostname = originalUrlHostname;

    const ai_summary = await summarizeText(articleData.title, articleData.snippet);
    console.log(`[BEFORE generateAndStoreImage] In /api/add-news. Title: ${articleData.title}, Link: ${articleData.link}`);
    const ai_image_url = await generateAndStoreImage(articleData.title, articleData.link); // Generate and store image
    console.log(`[AFTER generateAndStoreImage] In /api/add-news. Resulting ai_image_url: ${ai_image_url}`);
    const newItem = { url: articleData.link, title: articleData.title, ai_summary, ai_image_url, source: sourceHostname, processed_at: new Date().toISOString() };

    console.log('Attempting manual insert:', JSON.stringify(newItem, null, 2));
    const { error: insertError } = await supabase.from('latest_news').insert(newItem);
    if (insertError) {
        console.error("Supabase insert error:", insertError);
        // Let the generic error handler below deal with Supabase insert errors (like unique constraint)
        throw insertError;
    }

    console.log('Manual insert successful.');
    return res.status(201).json({ message: 'Article processed successfully.', data: newItem });

  } catch (error) { // Generic error handler
    console.error('Error in /api/add-news:', error);
    if (error.code === '23505') { // Handle Supabase unique constraint violation specifically
        return res.status(409).json({ message: 'URL already exists (detected during insert).' });
    }
    // Handle other Supabase errors or unexpected issues
    return res.status(500).json({ error: 'Internal server error processing URL.', details: error.message });
  }
});

// Endpoint to get the defined search queries
// Added comment to force redeploy
app.get('/api/search-queries', (req, res) => {
  // We need the list of queries defined here
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
  res.status(200).json({ queries: searchQueries });
});

// --- News Fetching Endpoint with Caching ---
app.get('/api/latest-news', async (req, res) => {
  if (!supabase) {
      console.error('/api/latest-news: Supabase client not available.');
      res.setHeader('Cache-Control', 'no-store'); 
      return res.status(503).json({ error: 'Database client not available.' });
  }
  console.log('[BACKEND /api/latest-news] Attempting to fetch news...');
  try {
      const { data, error } = await supabase
          .from('latest_news')
          .select('*') 
          .order('processed_at', { ascending: false });

      if (error) {
          console.error('[BACKEND /api/latest-news] Supabase error:', error);
          res.setHeader('Cache-Control', 'no-store'); 
          throw error;
      }

      console.log('[BACKEND /api/latest-news] Supabase returned items count:', (data || []).length);
      if (data && data.length > 0) {
        console.log('[BACKEND /api/latest-news] First item from Supabase:', data[0].id, data[0].title);
      }

      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      res.status(200).json(data || []);

  } catch (error) {
      if (!res.getHeader('Cache-Control')) {
          res.setHeader('Cache-Control', 'no-store');
      }
      if (!error.message?.includes('fetching latest news')) {
          console.error('[BACKEND /api/latest-news] Unexpected critical error:', error);
      }
      res.status(500).json({ error: 'Failed to fetch latest news.' });
  }
});

// Manual Trigger Fetch Endpoint (Processes ONE query per call for POST, ALL for GET/cron)
app.all('/api/trigger-fetch', async (req, res) => {
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

  // Check if it's a cron job (likely GET request) or manual trigger (POST request)
  const isCronJob = req.method === 'GET'; 

  if (isCronJob) {
    console.log('Cron job invocation (GET /api/trigger-fetch): Starting full fetch cycle.');
    let totalAddedByCron = 0;
    let errorsInCron = [];
    let queriesProcessedByCron = 0;

    for (let i = 0; i < searchQueries.length; i++) {
      const currentQuery = searchQueries[i];
      queriesProcessedByCron++;
      console.log(`Cron: Processing query #${i + 1}/${searchQueries.length}: "${currentQuery}"`);
      try {
        const result = await processQueryAndSave(currentQuery); // processQueryAndSave expects the query string
        if (result.status === 'success') {
          totalAddedByCron += result.count;
          console.log(`Cron: Query "${currentQuery}" successful. Added: ${result.count}`);
        } else {
          const errorMessage = `Cron: Query "${currentQuery}" failed. Status: ${result.status}, Details: ${JSON.stringify(result.error || result.message || 'N/A')}`;
          console.error(errorMessage);
          errorsInCron.push({ query: currentQuery, status: result.status, error: result.error || result.message });
          
          if (result.status === 'quota_error' || result.status === 'google_timeout_error') {
            console.warn(`Cron: Stopping further processing due to ${result.status} on query "${currentQuery}".`);
            break; 
          }
        }
      } catch (loopError) {
        const errorMessage = `Cron: Unexpected error during processing of query "${currentQuery}": ${loopError.message}`;
        console.error(errorMessage, loopError);
        errorsInCron.push({ query: currentQuery, status: 'loop_exception', error: loopError.message });
        break; // Stop on unexpected errors
      }
    }
    console.log(`Cron job finished. Processed ${queriesProcessedByCron}/${searchQueries.length} queries. Total articles added: ${totalAddedByCron}. Errors: ${errorsInCron.length}`);
    return res.status(200).json({ 
        message: 'Cron fetch cycle completed.', 
        queriesProcessed: queriesProcessedByCron,
        totalQueries: searchQueries.length,
        totalAdded: totalAddedByCron, 
        errors: errorsInCron 
    });

  } else if (req.method === 'POST') { // Manual trigger from Admin Panel
    let { queryIndex } = req.body;

    if (queryIndex === undefined) {
        // This case should ideally not be hit if frontend always sends queryIndex for POST
        console.warn('/api/trigger-fetch POST: queryIndex not found in req.body, defaulting to 0. This might indicate an issue with the client request.');
        queryIndex = 0; 
    }

    if (typeof queryIndex !== 'number' || queryIndex < 0 || queryIndex >= searchQueries.length) {
      return res.status(400).json({ error: 'Invalid queryIndex provided.', providedIndex: req.body.queryIndex, totalQueries: searchQueries.length });
    }

    const currentQuery = searchQueries[queryIndex];
    console.log(`Manual fetch (POST /api/trigger-fetch) for query #${queryIndex + 1}/${searchQueries.length}: "${currentQuery}"`);

    try {
      const result = await processQueryAndSave(currentQuery);

      if (result.status === 'success') {
        const addedCount = result.count;
        const nextIndex = (queryIndex + 1 < searchQueries.length) ? queryIndex + 1 : null;
        console.log(`Query #${queryIndex + 1} ("${currentQuery}") processed successfully. Added: ${addedCount}. Next index: ${nextIndex}`);
        return res.status(200).json({
          message: `Query ${queryIndex + 1}/${searchQueries.length} processed successfully.`, 
          query: currentQuery,
          addedCount: addedCount,
          nextIndex: nextIndex
        });
      } else if (result.status === 'quota_error') {
        console.warn(`Stopping manual fetch due to Google API quota limit hit on query index ${queryIndex} ("${currentQuery}").`);
        return res.status(429).json({
            error: 'Google Search API quota exceeded.',
            message: `Processing stopped at query index ${queryIndex} due to quota limit. Please try again later.`,
            query: currentQuery,
            processedCount: result.count, 
            nextIndex: null 
        });
      } else if (result.status === 'google_timeout_error') {
        console.warn(`Stopping manual fetch due to Google API timeout on query index ${queryIndex} ("${currentQuery}").`);
        return res.status(504).json({ 
            error: 'Google Search API call timed out.',
            message: `Processing stopped at query index ${queryIndex} because the Google API call timed out.`,
            query: currentQuery,
            processedCount: result.count, 
            nextIndex: null 
        });
      } else { // Other errors like 'db_error', 'google_api_error'
        console.error(`Stopping manual fetch due to an error (${result.status}) during processing of query index ${queryIndex} ("${currentQuery}"). Details: ${JSON.stringify(result.error || result.message)}`);
        return res.status(500).json({
            error: `An internal error (${result.status}) occurred while processing the query.`,
            details: result.error || result.message,
            query: currentQuery,
            processedCount: result.count, 
            nextIndex: null 
        });
      }
    } catch (error) {
      console.error(`Unexpected error in POST /api/trigger-fetch for query #${queryIndex} ("${currentQuery}"):`, error);
      return res.status(500).json({
        error: 'An unexpected server error occurred.', 
        details: error.message,
        query: currentQuery
      });
    }
  } else {
    // Handle other methods if necessary, or return 405 Method Not Allowed
    console.warn(`/api/trigger-fetch called with unhandled method: ${req.method}`);
    return res.status(405).json({ error: `Method ${req.method} not allowed for /api/trigger-fetch.` });
  }
});

// Update the batch-update-stories endpoint
app.post('/api/batch-update-stories', async (req, res) => {
  console.log('[/api/batch-update-stories ENDPOINT HIT] Request received.');
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  if (!openai) return res.status(503).json({ error: 'OpenAI client not available.' });
  
  const { batch_size = 2, continue_token } = req.body;
  
  try {
    // Build the query to get stories where ai_image_url is NULL
    let query = supabase
      .from('latest_news')
      .select('*')
      .is('ai_image_url', null); // Filter for stories where ai_image_url is NULL
    
    // If we have a continue token (last processed ID from the previous batch of NULL image stories),
    // start after that ID. We order by 'id' for consistent pagination.
    if (continue_token) {
      query = query.gt('id', continue_token);
    }
    
    // Order by 'id' to ensure consistent batching when using continue_token
    query = query.order('id', { ascending: true }).limit(batch_size);
    
    const { data: stories, error } = await query;
    
    if (error) {
      console.error('Error fetching stories for batch update:', error);
      return res.status(500).json({ error: 'Database error fetching stories.', details: error.message });
    }
    
    if (!stories || stories.length === 0) {
      return res.status(200).json({ message: 'No more stories found to update.', done: true });
    }
    
    console.log(`Found ${stories.length} stories to refresh.`);
    
    // Process each story
    const results = [];
    let lastProcessedId = null;
    
    for (const story of stories) {
      console.log(`Processing story: ${story.id} - ${story.title}`);
      lastProcessedId = story.id;
      
      // If we need to fetch Google metadata first (for snippet)
      let snippet = story.snippet || '';
      let title = story.title || '';
      
      if (!snippet && story.url) {
        try {
          console.log(`Fetching metadata for: ${story.url}`);
          const googleResponse = await fetchArticlesFromGoogle(story.url, 1);
          
          if (googleResponse.success && 
              googleResponse.articles && 
              googleResponse.articles.length > 0) {
            const articleData = googleResponse.articles[0];
            snippet = articleData.snippet || '';
            
            // Use Google's title if we don't have one
            if (!title && articleData.title) {
              title = articleData.title;
            }
          }
        } catch (err) {
          console.error(`Error fetching Google data for ${story.url}:`, err);
          // Continue with what we have
        }
      }
      
      // Always update both AI summary and image
      let updates = {};
      let wasUpdated = false;
      
      // Generate new AI summary
      if (title && snippet) {
        const ai_summary = await summarizeText(title, snippet);
        if (ai_summary) {
          updates.ai_summary = ai_summary;
          wasUpdated = true;
        }
      }
      
      // Generate new image
      if (title && story.url) {
        const ai_image_url = await generateAndStoreImage(title, story.url);
        if (ai_image_url) {
          updates.ai_image_url = ai_image_url;
          wasUpdated = true;
        }
      }
      
      // Update the story if we have changes
      if (wasUpdated) {
        updates.processed_at = new Date().toISOString();
        const { error: updateError } = await supabase
          .from('latest_news')
          .update(updates)
          .eq('id', story.id);
          
        if (updateError) {
          console.error(`Error updating story ${story.id}:`, updateError);
          results.push({ 
            id: story.id, 
            success: false, 
            message: updateError.message 
          });
        } else {
          console.log(`Successfully refreshed story ${story.id}`);
          results.push({ 
            id: story.id, 
            success: true, 
            updates: Object.keys(updates) 
          });
        }
      } else {
        results.push({ 
          id: story.id, 
          success: true, 
          message: 'No updates applied' 
        });
      }
      
      // Add a longer delay between API calls to avoid rate limits
      console.log(`Waiting 2 seconds before processing next story...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Return results and a continue token if more processing is needed
    // The 'done' flag is true if the number of stories processed is less than the batch_size,
    // indicating no more stories matching the criteria (ai_image_url is NULL) were found in this batch.
    return res.status(200).json({
      message: `Processed ${stories.length} stories`,
      results,
      continue_token: lastProcessedId, // This will be the ID of the last story processed in this batch
      done: stories.length < batch_size 
    });
    
  } catch (error) {
    console.error('Error in batch update stories:', error);
    return res.status(500).json({ error: 'Internal server error processing batch.', details: error.message });
  }
});

// New Endpoint to Regenerate Image for a Specific Article ID
app.post('/api/regenerate-image', async (req, res) => {
  console.log('[/api/regenerate-image ENDPOINT HIT] Request received.');
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  if (!openai) return res.status(503).json({ error: 'OpenAI client not available.' });

  let { article_id } = req.body; // Keep as let if we reassign after trim

  if (!article_id || typeof article_id !== 'string' || article_id.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid article_id in request body. Must be a non-empty string.' });
  }

  article_id = article_id.trim(); // Trim whitespace

  // Basic UUID format check (optional, but good for early feedback)
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(article_id)) {
    return res.status(400).json({ error: 'Invalid article_id format. Must be a valid UUID.' });
  }

  try {
    // 1. Fetch the article details (title, url) from the database using the UUID string directly
    const { data: story, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, title, url')
      .eq('id', article_id) // Use article_id (UUID string) directly
      .maybeSingle();

    if (fetchError) {
      console.error(`Error fetching story ${article_id} for image regeneration:`, fetchError);
      return res.status(500).json({ error: 'Database error fetching story.', details: fetchError.message });
    }

    if (!story) {
      return res.status(404).json({ error: `Story with ID ${article_id} not found.` });
    }

    if (!story.title || !story.url) {
      return res.status(400).json({ error: `Story with ID ${article_id} is missing a title or URL, cannot regenerate image.` });
    }

    console.log(`Attempting to regenerate image for story ID: ${article_id}, Title: ${story.title}`);

    // 2. Generate and store the new image
    const new_ai_image_url = await generateAndStoreImage(story.title, story.url);

    if (!new_ai_image_url) {
      console.error(`Failed to generate a new image for story ID: ${article_id}`);
      return res.status(500).json({ error: 'Image generation failed. Please check backend logs.' });
    }

    console.log(`New image generated for story ID: ${article_id}, URL: ${new_ai_image_url}`);

    // 3. Update the story in the database with the new image URL and processed_at
    const updates = {
      ai_image_url: new_ai_image_url,
      processed_at: new Date().toISOString() // Update processed_at timestamp
    };

    const { error: updateError } = await supabase
      .from('latest_news')
      .update(updates)
      .eq('id', article_id); // Use article_id (UUID string) directly

    if (updateError) {
      console.error(`Error updating story ${article_id} with new image:`, updateError);
      return res.status(500).json({ error: 'Database error updating story with new image.', details: updateError.message });
    }

    console.log(`Successfully regenerated image and updated story ID: ${article_id}`);
    return res.status(200).json({ 
      message: `Image regenerated successfully for story ID: ${article_id}.`,
      article_id: article_id, // Send back the UUID string
      new_ai_image_url: new_ai_image_url 
    });

  } catch (error) {
    console.error(`Unexpected error in /api/regenerate-image for ID ${article_id}:`, error);
    return res.status(500).json({ error: 'Internal server error regenerating image.', details: error.message });
  }
});

// --- New Whitepaper Signup Endpoint ---
app.post('/api/whitepaper-signup', async (req, res) => {
  if (!supabase) {
    console.error('/api/whitepaper-signup: Supabase client not available.');
    return res.status(503).json({ error: 'Database client not available. Cannot save email.' });
  }

  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required and must be a string.' });
  }

  // Basic email validation regex (more robust validation can be added)
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  try {
    const { data, error } = await supabase
      .from('whitepaper_leads')
      .insert([{ email: email.toLowerCase() }]) // Store email in lowercase to avoid duplicates
      .select(); // Optionally select to confirm or get the ID

    if (error) {
      // Handle potential duplicate email error (unique constraint violation)
      if (error.code === '23505') { // PostgreSQL unique violation code
        console.warn(`Whitepaper signup: Email already exists - ${email}`);
        // Consider it a success if they already signed up, or return a specific message
        return res.status(200).json({ message: 'Email already registered. You can download the whitepaper.' });
      } else {
        console.error('Supabase error inserting whitepaper lead:', error);
        return res.status(500).json({ error: 'Database error saving email.' });
      }
    }

    console.log(`Whitepaper signup: Email saved - ${email}`, data);
    return res.status(201).json({ message: 'Email successfully saved. You can now download the whitepaper.' });

  } catch (error) {
    console.error('Unexpected error in /api/whitepaper-signup:', error);
    return res.status(500).json({ error: 'An unexpected server error occurred.' });
  }
});
// --- End Whitepaper Signup Endpoint ---

app.post('/api/submit-article-url', async (req, res) => {
    console.log('[POST /api/submit-article-url] Received request:', req.body);
    const { url: articleUrl } = req.body;

    if (!articleUrl) {
        return res.status(400).json({ message: 'Missing article URL in request body.' });
    }

    let sourceHostname = 'unknown';
    try {
        sourceHostname = new URL(articleUrl).hostname;
        if (sourceHostname.startsWith('www.')) {
            sourceHostname = sourceHostname.substring(4);
        }
    } catch (e) {
        console.warn(`[POST /api/submit-article-url] Could not parse hostname from URL: ${articleUrl}. Using default '${sourceHostname}'.`);
    }

    if (!supabase) {
        console.error('[POST /api/submit-article-url] Supabase client not initialized.');
        return res.status(500).json({ message: 'Database service not available.' });
    }

    try {
        console.log(`[POST /api/submit-article-url] Checking for duplicate URL: ${articleUrl}`);
        const { data: existingArticle, error: selectError } = await supabase
            .from('latest_news')
            .select('url')
            .eq('url', articleUrl)
            .maybeSingle();

        if (selectError) {
            console.error('[POST /api/submit-article-url] Error checking for duplicate URL:', selectError);
            return res.status(500).json({ message: 'Error checking for duplicate URL.', details: selectError.message });
        }

        if (existingArticle) {
            console.log(`[POST /api/submit-article-url] URL ${articleUrl} already exists in database. Skipping.`);
            return res.status(200).json({ message: 'URL already processed.', article: existingArticle });
        }

        console.log(`[POST /api/submit-article-url] URL ${articleUrl} is new. Proceeding with processing.`);

        const { title, snippet } = await fetchArticleDetails(articleUrl);
        // Title and snippet can be null if fetchArticleDetails fails gracefully for certain sites (e.g. X.com)

        let summary = null; // Initialize summary
        const isXUrl = articleUrl.includes('x.com') || articleUrl.includes('twitter.com');

        if (isXUrl && snippet && snippet !== 'Could not fetch content. The source may be dynamic or protected.') {
            console.log(`[POST /api/submit-article-url] X.com URL detected with snippet. Using snippet directly as summary.`);
            summary = snippet; // Use the fetched snippet (tweet text) as the summary
        } else if (openai && title && snippet) { 
            console.log(`[POST /api/submit-article-url] Generating AI summary for: ${title}`);
            summary = await summarizeText(title, snippet);
        } else {
            console.warn('[POST /api/submit-article-url] Skipping summary generation (OpenAI not available, or missing title/snippet, or X.com URL without snippet).');
            // Summary remains null if it couldn't be generated or assigned from X.com snippet
        }

        let imageUrl = null;
        if (openai && title) {
            console.log(`[POST /api/submit-article-url] Generating image for: ${title}`);
            imageUrl = await generateAndStoreImage(title, articleUrl);
        } else {
            console.warn('[POST /api/submit-article-url] Skipping image generation (OpenAI not available or missing title).');
        }

        console.log(`[POST /api/submit-article-url] Saving article to Supabase. URL: ${articleUrl}, Source: ${sourceHostname}`);
        const { data: newArticle, error: insertError } = await supabase
            .from('latest_news')
            .insert([
                {
                    url: articleUrl,
                    title: title || 'Title not available',
                    ai_summary: summary, // This will be the X.com snippet or AI summary
                    ai_image_url: imageUrl,
                    source: sourceHostname,
                    processed_at: new Date().toISOString()
                },
            ])
            .select();

        if (insertError) {
            console.error('[POST /api/submit-article-url] Error saving article to Supabase:', insertError);
            return res.status(500).json({ message: 'Error saving article to database.', details: insertError.message });
        }

        console.log('[POST /api/submit-article-url] Article successfully processed and saved:', newArticle);
        return res.status(201).json({ message: 'Article processed and saved successfully.', article: newArticle });

    } catch (error) {
        console.error('[POST /api/submit-article-url] Unexpected error processing article:', error);
        return res.status(500).json({ message: 'An unexpected error occurred.', details: error.message });
    }
});

// Import the main function from the Gmail processor script
// Adjust the path if your script or api/index.js moves.
// Assuming api/index.js is in microplastics-pulse-backend/api/
// and the script is in microplastics-pulse-backend/scripts/gmail-processor/index.js
let gmailProcessorModule;
let gmailProcessorMain; // Ensure it's declared so it can be null

try {
    console.log(`[CRON EMAIL DEBUG] Attempting to load gmail-processor script from path: '../scripts/gmail-processor/index.js'`);
    gmailProcessorModule = require('../scripts/gmail-processor/index.js'); // Corrected path
    console.log(`[CRON EMAIL DEBUG] gmail-processor script loaded via require.`);
    
    if (gmailProcessorModule) {
        console.log(`[CRON EMAIL DEBUG] Module loaded. Type: ${typeof gmailProcessorModule}. Keys: ${Object.keys(gmailProcessorModule).join(', ')}`);
        if (gmailProcessorModule.hasOwnProperty('main')) {
            console.log(`[CRON EMAIL DEBUG] Module has 'main' property. Type of main: ${typeof gmailProcessorModule.main}`);
            if (typeof gmailProcessorModule.main === 'function') {
                gmailProcessorMain = gmailProcessorModule.main;
                console.log("[CRON EMAIL DEBUG] Successfully assigned gmailProcessorModule.main to gmailProcessorMain.");
            } else {
                console.error("[CRON EMAIL DEBUG] Error: gmailProcessorModule.main is not a function.");
                gmailProcessorMain = null;
            }
        } else {
            console.error("[CRON EMAIL DEBUG] Error: gmailProcessorModule does not have 'main' property.");
            gmailProcessorMain = null;
        }
    } else {
        console.error("[CRON EMAIL DEBUG] Error: require('../scripts/gmail-processor/index.js') returned null or undefined.");
        gmailProcessorMain = null;
    }
} catch (error) {
    console.error("[CRON EMAIL DEBUG] CRITICAL: Failed to load gmail-processor script via require. Error details:", error);
    // It's important to log the actual error object here
    if (error && error.message) console.error("[CRON EMAIL DEBUG] Error message:", error.message);
    if (error && error.stack) console.error("[CRON EMAIL DEBUG] Error stack:", error.stack);
    gmailProcessorMain = null;
}

// New Cron Job Endpoint to trigger email check
app.get('/api/cron/check-emails', async (req, res) => {
    // Security check for the cron trigger secret
    const expectedSecret = process.env.CRON_TRIGGER_SECRET;
    const receivedSecret = req.headers['x-custom-cron-secret']; // Header names are conventionally lowercase

    if (!expectedSecret) {
        // This is a server configuration issue if the secret isn't set.
        console.error('[CRON /api/cron/check-emails] CRON_TRIGGER_SECRET is not set in server environment.');
        return res.status(500).send('Internal server configuration error.');
    }

    if (receivedSecret !== expectedSecret) {
        console.warn('[CRON /api/cron/check-emails] Unauthorized attempt: Missing or incorrect secret header.');
        return res.status(401).send('Unauthorized');
    }

    console.log('[CRON /api/cron/check-emails] Authorized request received to check emails.');

    if (!gmailProcessorMain) {
        console.error('[CRON /api/cron/check-emails] Gmail processor script not loaded. Final check failed. Cannot run email check.'); // Modified this log for clarity
        return res.status(500).json({ message: 'Email processing script not available. Investigation required.'});
    }

    try {
        // Execute the main function from the gmail-processor script
        // This is an async function, so we await its completion.
        await gmailProcessorMain();
        console.log('[CRON /api/cron/check-emails] Email check process completed.');
        return res.status(200).json({ message: 'Email check process triggered successfully.' });
    } catch (error) {
        console.error('[CRON /api/cron/check-emails] Error during email check process:', error);
        return res.status(500).json({ message: 'Error during email check process.', details: error.message });
    }
});

// Export the Express API for Vercel
module.exports = app;

// For local direct testing with `node api/index.js`
// This block will only run if the file is executed directly by Node,
// and not when it's just `require`d by Vercel's runtime.
if (require.main === module) {
  const localPort = process.env.PORT || 3001; // Use PORT from .env if available, else 3001
  app.listen(localPort, () => {
    console.log(`Backend server listening directly on http://localhost:${localPort}`);
  });
}