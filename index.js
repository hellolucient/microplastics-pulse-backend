require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors'); // Require the cors middleware
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios'); // Keep this for Google Search
const cron = require('node-cron'); // Add this for scheduling
const { postSingleTweet } = require('./lib/twitterService');

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

// --- ADDED LATEST NEWS ENDPOINT ---
app.get('/api/latest-news', async (req, res) => {
  if (!supabase) {
      console.error('/api/latest-news: Supabase client not available.');
      res.setHeader('Cache-Control', 'no-store'); 
      return res.status(503).json({ error: 'Database client not available.' });
  }
  try {
      const { data, error } = await supabase
          .from('latest_news')
          .select('*') 
          .order('processed_at', { ascending: false })
          .limit(50); // Example limit

      if (error) {
          console.error('Error fetching latest news:', error);
          res.setHeader('Cache-Control', 'no-store'); 
          // Instead of throwing, send a response directly for clarity
          return res.status(500).json({ error: 'Database error fetching latest news.', details: error.message });
      }
      // For local dev, caching headers might not be strictly necessary but don't hurt
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      res.status(200).json(data || []);
  } catch (error) { // This outer catch is for truly unexpected errors
      if (!res.getHeader('Cache-Control')) {
          res.setHeader('Cache-Control', 'no-store');
      }
      // Avoid double logging if already logged
      if (!error.message?.includes('fetching latest news') && !error.message?.includes('Supabase client not available')) {
          console.error('Unexpected critical error in /api/latest-news:', error);
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to fetch latest news due to an unexpected server issue.' });
      }
  }
});
// --- END ADDED LATEST NEWS ENDPOINT ---

// --- Twitter Integration Endpoints ---

/**
 * Gets the next three stories that should be posted to Twitter.
 * Implements the "Oldest, Newest, Second Oldest" strategy.
 */
app.get('/api/admin/next-tweet-candidate', async (req, res) => {
  try {
    // Fetch two oldest stories that haven't been posted
    const { data: oldestStories, error: oldestError } = await supabase
      .from('latest_news')
      .select('*')
      .eq('is_posted_to_twitter', false)
      .order('published_date', { ascending: true })
      .limit(2);

    if (oldestError) throw oldestError;

    // Fetch the newest story that hasn't been posted
    const { data: newestStory, error: newestError } = await supabase
      .from('latest_news')
      .select('*')
      .eq('is_posted_to_twitter', false)
      .order('published_date', { ascending: false })
      .limit(1)
      .single(); // We only expect one

    if (newestError) throw newestError;

    // We need to handle cases where there are fewer than 3 stories left
    if (!oldestStories || oldestStories.length === 0) {
      return res.status(404).json({ message: 'No more stories to post.' });
    }

    const candidates = [];
    if (oldestStories[0]) candidates.push(oldestStories[0]);
    if (newestStory) candidates.push(newestStory);
    if (oldestStories[1]) candidates.push(oldestStories[1]);
    
    // Remove duplicates in case the oldest and newest are the same
    const uniqueCandidates = Array.from(new Set(candidates.map(s => s.id)))
      .map(id => candidates.find(s => s.id === id));

    res.status(200).json(uniqueCandidates);

  } catch (error) {
    console.error('Error fetching next tweet candidates:', error);
    res.status(500).json({ error: 'Failed to fetch tweet candidates.', details: error.message });
  }
});


/**
 * Posts a tweet for a given story ID with the provided text.
 */
app.post('/api/admin/post-tweet', async (req, res) => {
  const { storyId, tweetText } = req.body;

  if (!storyId || !tweetText) {
    return res.status(400).json({ error: 'Story ID and tweet text are required.' });
  }

  try {
    // 1. Fetch the story details from Supabase
    const { data: story, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, ai_image_url')
      .eq('id', storyId)
      .single();

    if (fetchError) throw fetchError;
    if (!story) {
      return res.status(404).json({ error: 'Story not found.' });
    }

    // 2. Post to Twitter using the service
    const result = await postSingleTweet(tweetText, story.ai_image_url);

    if (!result.success) {
      // Forward the error from the twitterService
      return res.status(500).json({ error: 'Failed to post tweet.', details: result.error });
    }

    // 3. Update the story in Supabase to mark as posted
    const { error: updateError } = await supabase
      .from('latest_news')
      .update({ is_posted_to_twitter: true })
      .eq('id', storyId);

    if (updateError) {
      // This is a critical issue. The tweet went out but we couldn't mark it.
      // Log this for manual intervention.
      console.error(`CRITICAL: Tweet posted for story ${storyId} but failed to update 'is_posted_to_twitter' flag.`, updateError);
      // Inform the client, but the tweet was successful.
      return res.status(200).json({ 
        message: 'Tweet posted successfully, but failed to update the story status in the database. Please check logs.',
        tweet: result.tweet 
      });
    }

    res.status(200).json({ message: 'Tweet posted successfully!', tweet: result.tweet });

  } catch (error) {
    console.error(`Error processing post-tweet request for story ${storyId}:`, error);
    res.status(500).json({ error: 'Internal server error.', details: error.message });
  }
});


// Helper function to post a single tweet based on a story object
async function postTweet(story) {
  if (!story || !story.id) {
    console.log('postTweet helper received invalid story object. Skipping.');
    return;
  }

  try {
    console.log(`Generating tweet for story: ${story.title}`);
    const hashtags = await generateHashtags(story.ai_summary);
    // Construct the tweet text, ensuring it's within limits
    // URL takes up 23 chars, leave space for hashtags and truncation.
    const url = `https://www.microplastics-pulse.com/story/${story.id}`; // Assuming a future story page
    const availableChars = 280 - url.length - hashtags.length - 4; // 4 for "..." and spaces
    const truncatedSummary = story.ai_summary.length > availableChars 
      ? story.ai_summary.substring(0, availableChars) + '...' 
      : story.ai_summary;
    
    const tweetText = `${truncatedSummary}\n\n${hashtags}\n${url}`;

    console.log(`Posting tweet: ${tweetText}`);
    const result = await postSingleTweet(tweetText, story.ai_image_url);

    if (result.success) {
      console.log(`Tweet for story ${story.id} posted successfully. Updating database.`);
      const { error: updateError } = await supabase
        .from('latest_news')
        .update({ is_posted_to_twitter: true })
        .eq('id', story.id);
      
      if (updateError) {
        console.error(`CRITICAL: Tweet posted for story ${story.id} but DB update failed!`, updateError);
      }
    } else {
      console.error(`Failed to post tweet for story ${story.id}:`, result.error);
    }
  } catch (error) {
    console.error(`An unexpected error occurred in postTweet for story ${story.id}:`, error);
  }
}

// --- END Twitter Integration ---

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
 * Generates a concise summary for a given title and snippet using OpenAI.
 * @param {string} title The title of the article.
 * @param {string} snippet The snippet/description of the article.
 * @returns {Promise<string>} The AI-generated summary.
 */
async function summarizeText(title, snippet) {
  if (!title || !snippet) return null;
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
 * Generates relevant hashtags for a given text using OpenAI.
 * @param {string} summary The text summary of the article.
 * @returns {Promise<string>} A string of 2-3 relevant hashtags.
 */
async function generateHashtags(summary) {
  if (!summary) return '#microplastics';

  try {
    const prompt = `Based on the following summary, generate exactly 2 relevant and specific Twitter hashtags. Do not include the #microplastics hashtag, it will be added automatically. The hashtags should be concise and directly related to the key topics. Format them as a single string with spaces, like "#topicone #topictwo".\n\nSummary: "${summary}"`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 20,
      temperature: 0.5,
      n: 1,
    });

    const generatedText = response.choices[0].message.content.trim();
    // Clean up the text to ensure it's just hashtags
    const cleanedHashtags = generatedText.split(' ').filter(tag => tag.startsWith('#')).join(' ');

    return `#microplastics ${cleanedHashtags}`.trim();
  } catch (error) {
    console.error('Error generating hashtags with OpenAI:', error);
    return '#microplastics'; // Fallback
  }
}

// --- Scheduled Tasks ---
// Cron job to run the tweet posting logic 3 times a day.
// Currently disabled. Will be enabled when the feature is ready for automation.
/*
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('--- Running Scheduled Tweet Job ---');
  try {
    // Fetch the next story to post (e.g., the oldest one)
     const { data: story, error } = await supabase
      .from('latest_news')
      .select('*')
      .eq('is_posted_to_twitter', false)
      .order('published_date', { ascending: true })
      .limit(1)
      .single();

    if (error) throw error;

    if (story) {
      await postTweet(story);
    } else {
      console.log('No new stories to tweet.');
    }
  } catch (error) {
    console.error('Error in scheduled tweet job:', error);
  }
}, {
  scheduled: true,
  timezone: "UTC"
});
*/

// --- Server Initialization ---
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