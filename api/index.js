require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); 
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');
const { put } = require('@vercel/blob'); // Added Vercel Blob import
const cheerio = require('cheerio'); // Added Cheerio
const he = require('he'); // Added he library
const nodemailer = require('nodemailer'); // Add nodemailer
const { postSingleTweet } = require('../lib/twitterService'); // Correct path from /api

const app = express();

// --- Middleware ---
app.use(express.json()); 

const allowedOrigins = [
  'https://microplastics-pulse.vercel.app',
  'https://www.microplasticswatch.com',
  'https://microplasticswatch.com',
  'http://localhost:3000',
  'http://localhost:5173',
  /https:\/\/microplastics-pulse-frontend.*\\.vercel\\.app$/
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    let isAllowed = false;
    for (const allowed of allowedOrigins) {
      if (typeof allowed === 'string' && allowed === origin) {
        isAllowed = true;
        break;
      }
      if (allowed instanceof RegExp && allowed.test(origin)) {
        isAllowed = true;
        break;
      }
    }
    if (isAllowed) {
      return callback(null, true);
    } else {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
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

// --- Helper Functions ---
async function fetchArticlesFromGoogle(query, numResults = 10) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cxId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    const apiUrl = "https://www.googleapis.com/customsearch/v1";
    if (!apiKey || !cxId) {
        return { success: false, error: { message: "Google API Key or CX ID is missing." } };
    }
    const params = { key: apiKey, cx: cxId, q: query, num: numResults };
    try {
        const response = await axios.get(apiUrl, { params, timeout: 25000 });
        if (response.data && response.data.items) {
            const articles = response.data.items.map(item => ({ title: item.title, link: item.link, snippet: item.snippet }));
            return { success: true, articles: articles };
        } else {
            return { success: true, articles: [] };
        }
    } catch (error) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.error?.message || error.message;
        if (error.code === 'ECONNABORTED') {
            return { success: false, error: { status: 'TIMEOUT', message: 'Google API call timed out.' } };
        }
        return { success: false, error: { status: status, message: errorMessage } };
    }
}

async function summarizeText(title, snippet) {
    if (!openai || !title || !snippet) return null;
    const prompt = `Generate a detailed summary of the article titled "${title}" with the provided snippet: "${snippet}". The summary should be comprehensive, approximately 6-8 sentences long (around 150-200 words). It must capture the main topics and key findings. Crucially, ensure the summary includes specific examples, important terms, likely key search terms, mentions of product types (e.g., water bottles, food packaging), and relevant category mentions (e.g., health impacts, environmental sources) if present in the article. The primary goal is to provide enough detail to significantly improve searchability for these specific keywords and concepts within the article's content. Respond with only the summary.`;
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", 
            messages: [{ role: "user", content: prompt }], 
            max_tokens: 250,
            temperature: 0.5, 
            n: 1,
        });
        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
        console.error('Error generating summary with OpenAI:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
        return null;
    }
}

async function generateAndStoreImage(title, articleUrl) {
    if (!openai || !process.env.BLOB_READ_WRITE_TOKEN || !title || !articleUrl) {
        console.error("generateAndStoreImage: Pre-requisites not met (OpenAI, Blob Token, title, or URL).");
        return null;
    }
    const new_prompt = `Generate a realistic, editorial-style photo illustration for an article titled \"${title.substring(0, 150)}\". The image must visually communicate the article's core theme using real-world elements, settings, or symbolic objects. **Absolutely no text, letters, words, or numbers should appear anywhere in the image.** If people are depicted, their expressions should be neutral or show subtle concern, reflecting a serious tone without being overly dramatic, distressed, or despairing. Critically, people should not be smiling or appear happy. The overall style must be grounded and avoid surreal or exaggerated elements. Use cinematic lighting or natural daylight appropriate to the article's mood. Ensure no watermarks or logos are present.`;
    try {
        const imageResponse = await openai.images.generate({
            model: "dall-e-3", prompt: new_prompt, n: 1, size: "1024x1024", response_format: "url", quality: "standard", style: "natural"
        });
        const tempImageUrl = imageResponse.data?.[0]?.url;
        if (!tempImageUrl) return null;
        const imageBufferResponse = await axios.get(tempImageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = imageBufferResponse.data;
        if (!imageBuffer) return null;
        const sanitizedUrlPart = articleUrl.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
        const filename = `article-images/${sanitizedUrlPart}-${Date.now()}.png`;
        const blob = await put(filename, imageBuffer, { access: 'public', contentType: 'image/png', addRandomSuffix: false, token: process.env.BLOB_READ_WRITE_TOKEN });
        return blob.url;
    } catch (error) {
        console.error('Error in generateAndStoreImage:', error.message);
        return null;
    }
}

async function generateTweetTextFromSummary(summary, maxLength) {
  if (!summary || !openai) {
      const truncated = summary.substring(0, maxLength - 3);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
  }

  const prompt = `You are a social media manager for an environmental news organization. Your task is to create a compelling tweet from the provided article summary.

Guidelines:
- The tone must be professional but urgent and engaging to encourage clicks.
- Extract the most eye-catching facts or statements from the summary.
- The final output MUST be a single block of text for the tweet body.
- CRITICALLY: Your entire response must NOT exceed ${maxLength} characters.
- Do NOT include any hashtags or URLs in your response.

Article Summary: "${summary}"`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Using a more capable model for this nuanced task
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100, // Roughly corresponds to ~400 chars, which is more than enough.
      temperature: 0.7,
      n: 1,
    });
    // We don't need to truncate here because we've asked the model to respect the length.
    return response.choices[0].message.content.trim().replace(/^"|"$/g, '');
  } catch (error) {
    console.error('Error generating tweet text with OpenAI:', error);
    // Fallback to simple truncation if API fails
    const truncated = summary.substring(0, maxLength - 3);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
  }
}

async function generateHashtags(summary) {
  if (!summary || !openai) return '#microplastics';
  try {
    const prompt = `Based on the following summary, generate 2-3 relevant and specific Twitter hashtags.
- Do NOT include the #microplastics hashtag, it will be added automatically.
- The hashtags should be concise and directly related to the key topics.
- Format them as a single string with spaces, like "#topicone #topictwo".

Summary: "${summary}"`;
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], max_tokens: 20, temperature: 0.5, n: 1,
    });
    const cleanedHashtags = response.choices[0].message.content.trim().split(' ').filter(tag => tag.startsWith('#')).join(' ');
    return `#microplastics ${cleanedHashtags}`.trim();
  } catch (error) {
    console.error('Error generating hashtags with OpenAI:', error);
    return '#microplastics';
  }
}

async function generateTweetPreview(story) {
  if (!story || !story.id || !story.ai_summary) return "Could not generate tweet preview.";

  // 1. Generate hashtags and define URL first to know their length.
  const hashtags = await generateHashtags(story.ai_summary);
  const storyUrl = `https://www.microplasticswatch.com/story/${story.id}`;
  
  // 2. Define constants for Twitter's character limits
  const TWEET_LIMIT = 280;
  const TCO_URL_LENGTH = 23;

  // 3. Calculate the maximum length available for the tweet's main text.
  const fixedPartsLength = TCO_URL_LENGTH + hashtags.length + 2; // +2 for spaces
  const maxTextLength = TWEET_LIMIT - fixedPartsLength;

  // 4. Generate the tweet's main text using the summary and calculated max length.
  const tweetText = await generateTweetTextFromSummary(story.ai_summary, maxTextLength);
  
  // 5. Assemble the final tweet text. No more truncation needed here.
  return `${tweetText} ${hashtags} ${storyUrl}`;
}

async function processQueryAndSave(query) {
    if (!supabase) return { status: 'db_error', count: 0 };
    const googleResponse = await fetchArticlesFromGoogle(query, 10);
    if (!googleResponse.success) {
        if (googleResponse.error?.status === 429) return { status: 'quota_error', count: 0 };
        if (googleResponse.error?.status === 'TIMEOUT') return { status: 'google_timeout_error', count: 0 };
        return { status: 'google_api_error', count: 0 };
    }
    const articles = googleResponse.articles;
    if (!articles || articles.length === 0) return { status: 'success', count: 0 };
    const { data: existingUrlsData, error: urlFetchError } = await supabase.from('latest_news').select('url');
    if (urlFetchError) return { status: 'db_error', count: 0 };
    const existingUrls = new Set(existingUrlsData.map(item => item.url));
    let newArticlesAdded = 0;
    for (const article of articles) {
        const { title, link: url, snippet } = article;
        if (!url || !title || !url.startsWith('http') || existingUrls.has(url)) continue;
        const ai_summary = await summarizeText(title, snippet);
        const ai_image_url = await generateAndStoreImage(title, url);
        let sourceHostname;
        try { sourceHostname = new URL(url).hostname; } catch (e) { continue; }
        const newItem = { url, title, ai_summary, ai_image_url, source: sourceHostname, processed_at: new Date().toISOString() };
        const { error: insertError } = await supabase.from('latest_news').insert(newItem);
        if (!insertError) {
            newArticlesAdded++;
            existingUrls.add(url);
        }
    }
    return { status: 'success', count: newArticlesAdded };
}

/**
 * NEW, ROBUST, HELPER: Fetches article details using Cheerio for better parsing.
 * @param {string} url The URL to scrape.
 * @returns {Promise<{title: string|null, snippet: string|null, finalUrl: string|null}>}
 */
async function fetchArticleDetails(url) {
    console.log(`[fetchArticleDetails] Fetching details for: ${url}`);
    try {
        const response = await axios.get(url, {
            timeout: 20000, // 20-second timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const finalUrl = response.request.res.responseUrl || url;
        console.log(`[fetchArticleDetails] Successfully fetched. Final URL: ${finalUrl}`);
        const html = response.data;

        const $ = cheerio.load(html);

        // Try to get title from common meta tags or the <title> tag
        const title = $('meta[property="og:title"]').attr('content') ||
                      $('meta[name="twitter:title"]').attr('content') ||
                      $('title').text();

        // Try to get description from common meta tags or the first <p> tag
        let snippet = $('meta[property="og:description"]').attr('content') ||
                      $('meta[name="twitter:description"]').attr('content') ||
                      $('meta[name="description"]').attr('content');

        if (!snippet) {
            // As a fallback, find the first meaningful paragraph
            $('p').each(function() {
                const p_text = $(this).text().trim();
                if (p_text.length > 100) { // Look for a reasonably long paragraph
                    snippet = p_text;
                    return false; // break the loop
                }
            });
        }
        
        // Clean up the text
        const cleanedTitle = title ? he.decode(title.trim()) : 'Title not found';
        const cleanedSnippet = snippet ? he.decode(snippet.trim()) : 'Snippet not found';

        return { title: cleanedTitle, snippet: cleanedSnippet, finalUrl };

    } catch (error) {
        console.error(`Error fetching article details for ${url}:`, error.message);
        if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            console.error(`[fetchArticleDetails] Request timed out for ${url}`);
            return { title: null, snippet: 'Could not fetch content. The request timed out.', finalUrl: url };
        }
        return { title: null, snippet: 'Could not fetch content. The source may be dynamic or protected.', finalUrl: url };
    }
}

/**
 * NEW: A reusable function to process a single submitted URL.
 * Contains the core logic previously in the /api/submit-article-url endpoint.
 * @param {string} articleUrl The URL of the article to process.
 * @returns {Promise<{success: boolean, message: string, data?: object, status?: number}>}
 */
async function processSubmittedUrl(articleUrl) {
    console.log(`[processSubmittedUrl] Received URL: ${articleUrl}`);
    if (!supabase) {
        return { success: false, message: 'Database client not available.', status: 503 };
    }
    if (!articleUrl || typeof articleUrl !== 'string' || !articleUrl.startsWith('http')) {
        return { success: false, message: 'Invalid or missing URL.', status: 400 };
    }

    try {
        const { title, snippet, finalUrl } = await fetchArticleDetails(articleUrl);
        const urlToProcess = finalUrl || articleUrl;

        const { data: existing } = await supabase.from('latest_news').select('url').eq('url', urlToProcess).maybeSingle();
        if (existing) {
            return { success: true, message: 'URL already exists.', status: 200 }; // Not an error, just already done.
        }
        
        if (snippet && snippet.includes('timed out')) {
            return { success: false, message: 'Failed to fetch content from the source URL (timeout).', status: 504 };
        }
        if (snippet === 'Could not fetch content. The source may be dynamic or protected.') {
            return { success: false, message: 'Failed to fetch content from the source URL.', status: 502 };
        }

        let summary = null;
        const isXUrl = urlToProcess.includes('x.com') || urlToProcess.includes('twitter.com');
        if (isXUrl && snippet) {
            summary = snippet;
        } else if (openai && title && snippet) {
            summary = await summarizeText(title, snippet);
        }

        let imageUrl = null;
        if (openai && title) {
            imageUrl = await generateAndStoreImage(title, urlToProcess);
        }

        const sourceHostname = new URL(urlToProcess).hostname;
        const newItem = {
            url: urlToProcess,
            title: title || 'Title not available',
            ai_summary: summary,
            ai_image_url: imageUrl,
            source: sourceHostname,
            processed_at: new Date().toISOString()
        };

        const { data: newArticle, error: insertError } = await supabase.from('latest_news').insert(newItem).select();
        if (insertError) {
            if (insertError.code === '23505') {
                return { success: true, message: 'URL already exists (race condition).', status: 200 };
            }
            throw insertError;
        }

        return { success: true, message: 'Article processed and saved successfully.', data: newArticle[0], status: 201 };

    } catch (error) {
        console.error(`[processSubmittedUrl] Error processing ${articleUrl}:`, error.message);
        return { success: false, message: 'Internal server error processing URL.', details: error.message, status: 500 };
    }
}

// --- API Endpoints ---
app.get('/api', (req, res) => res.send('Microplastics Pulse Backend API is running!'));

app.post('/api/add-news', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
    const { url } = req.body;
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid or missing URL.' });
    try {
        const { data: existing } = await supabase.from('latest_news').select('url').eq('url', url).maybeSingle();
        if (existing) return res.status(409).json({ message: 'URL already exists.' });
        const googleResponse = await fetchArticlesFromGoogle(url, 1);
        if (!googleResponse.success) return res.status(googleResponse.error?.status === 429 ? 429 : 500).json({ error: 'API communication error.' });
        const searchResults = googleResponse.articles;
        if (!searchResults || searchResults.length === 0) return res.status(404).json({ error: 'Could not retrieve metadata.' });
        const articleData = searchResults[0];
        const sourceHostname = new URL(url).hostname;
        const ai_summary = await summarizeText(articleData.title, articleData.snippet);
        const ai_image_url = await generateAndStoreImage(articleData.title, articleData.link);
        const newItem = { url: articleData.link, title: articleData.title, ai_summary, ai_image_url, source: sourceHostname, processed_at: new Date().toISOString() };
        const { error: insertError } = await supabase.from('latest_news').insert(newItem);
        if (insertError) throw insertError;
        return res.status(201).json({ message: 'Article processed successfully.', data: newItem });
    } catch (error) {
        return res.status(error.code === '23505' ? 409 : 500).json({ error: 'Internal server error.', details: error.message });
    }
});

app.get('/api/search-queries', (req, res) => {
  const searchQueries = [
      "latest research microplastics human health site:nature.com OR site:sciencedirect.com", "global microplastic pollution report 2025 site:who.int OR site:unep.org",
      "microplastics ubiquity environment food chain site:nature.com", "emerging health concerns microplastics 2025 site:thelancet.com OR site:nih.gov",
      "policy innovation to prevent microplastic contamination 2025", "how microplastics enter the human body ingestion inhalation dermal site:ncbi.nlm.nih.gov",
      "bioaccumulation of microplastics in human organs site:sciencedirect.com", "crossing blood brain barrier microplastics placenta gut brain site:nature.com",
      "translocation of microplastics to brain or placenta site:cell.com", "microplastics inflammation oxidative stress endocrine disruption site:ncbi.nlm.nih.gov",
      "microplastics gut microbiome dysbiosis immunity site:gut.bmj.com OR site:nature.com", "microplastics reproductive health fetal exposure site:thelancet.com",
      "microplastics impact on brain neurological disorders site:sciencedirect.com", "microplastics and chronic disease cancer diabetes cardiovascular site:who.int",
      "microplastics linked to erectile dysfunction antibiotic resistance superbugs", "food contamination microplastics seafood produce packaging site:efsa.europa.eu",
      "airborne microplastics indoor exposure site:epa.gov OR site:pubmed.ncbi.nlm.nih.gov", "textiles cosmetics furniture microplastic emissions site:echa.europa.eu",
      "wellness industry microplastics awareness detox contradictions site:gwi.org", "clean living vs microplastic reality wellness narrative site:mindbodygreen.com OR site:wellandgood.com",
      "microplastics detox evidence probiotics antioxidants site:ncbi.nlm.nih.gov", "individual microplastic exposure reduction tips 2025 site:cdc.gov OR site:who.int",
      "new technologies microplastic removal blood purification 2025", "probiotic and antioxidant strategies microplastic detox site:sciencedirect.com",
      "wellness program standards to reduce microplastic exposure site:spaindustry.org", "2025 microplastic research priorities wellness industry site:gwi.org OR site:nih.gov",
      "call to action microplastics wellness sustainability site:globalwellnesssummit.com", "research gaps in microplastic and human health site:thelancet.com OR site:who.int"
  ];
  res.status(200).json({ queries: searchQueries });
});

app.get('/api/latest-news', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  try {
      const { data, error } = await supabase.from('latest_news').select('*').order('processed_at', { ascending: false });
      if (error) throw error;
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      res.status(200).json(data || []);
  } catch (error) {
      res.status(500).json({ error: 'Failed to fetch latest news.' });
  }
});

app.get('/api/story/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database service is unavailable' });
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('latest_news')
      .select('*')
      .eq('id', id)
      .single();
    if (error) {
      if (error.code === 'PGRST116') { // PostgREST error for "Not a single row was returned"
        return res.status(404).json({ error: 'Story not found' });
      }
      throw error;
    }
    if (!data) {
      return res.status(404).json({ error: 'Story not found' });
    }
    res.status(200).json(data);
  } catch (error) {
    console.error(`Error fetching story with id ${id}:`, error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

app.get('/api/admin/next-tweet-candidate', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  try {
    const { data: oldestStories, error: oldestError } = await supabase.from('latest_news').select('*').eq('is_posted_to_twitter', false).order('published_date', { ascending: true }).limit(2);
    if (oldestError) throw oldestError;
    const { data: newestStory, error: newestError } = await supabase.from('latest_news').select('*').eq('is_posted_to_twitter', false).order('published_date', { ascending: false }).limit(1).single();
    if (newestError && newestError.code !== 'PGRST116') throw newestError;
    if (!oldestStories || oldestStories.length === 0) return res.status(404).json({ message: 'No more stories to post.' });
    const candidates = [];
    if (oldestStories[0]) candidates.push(oldestStories[0]);
    if (newestStory) candidates.push(newestStory);
    if (oldestStories[1]) candidates.push(oldestStories[1]);
    const uniqueCandidates = [...new Map(candidates.map(item => [item.id, item])).values()];
    const candidatesWithPreview = await Promise.all(uniqueCandidates.map(async (story) => {
        if (!story) return null;
        const generatedTweetText = await generateTweetPreview(story);
        return { ...story, generatedTweetText };
    }));
    res.status(200).json(candidatesWithPreview.filter(Boolean));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tweet candidates.', details: error.message });
  }
});

app.post('/api/admin/post-tweet', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { storyId, tweetText } = req.body;
  if (!storyId || !tweetText) return res.status(400).json({ error: 'Story ID and tweet text are required.' });
  try {
    const { data: story, error: fetchError } = await supabase.from('latest_news').select('id, ai_image_url').eq('id', storyId).single();
    if (fetchError) throw fetchError;
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    const result = await postSingleTweet(tweetText, story.ai_image_url);
    if (!result.success) return res.status(500).json({ error: 'Failed to post tweet.', details: result.error });
    const { error: updateError } = await supabase.from('latest_news').update({ is_posted_to_twitter: true }).eq('id', storyId);
    if (updateError) {
      console.error(`CRITICAL: Tweet posted for story ${storyId} but failed to update flag.`, updateError);
      return res.status(200).json({ message: 'Tweet posted, but DB update failed.', tweet: result.tweet });
    }
    res.status(200).json({ message: 'Tweet posted successfully!', tweet: result.tweet });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error.', details: error.message });
  }
});

app.all('/api/trigger-fetch', async (req, res) => {
  const searchQueries = [
      "latest research microplastics human health site:nature.com OR site:sciencedirect.com", "global microplastic pollution report 2025 site:who.int OR site:unep.org",
      "microplastics ubiquity environment food chain site:nature.com", "emerging health concerns microplastics 2025 site:thelancet.com OR site:nih.gov",
      "policy innovation to prevent microplastic contamination 2025", "how microplastics enter the human body ingestion inhalation dermal site:ncbi.nlm.nih.gov",
      "bioaccumulation of microplastics in human organs site:sciencedirect.com", "crossing blood brain barrier microplastics placenta gut brain site:nature.com",
      "translocation of microplastics to brain or placenta site:cell.com", "microplastics inflammation oxidative stress endocrine disruption site:ncbi.nlm.nih.gov",
      "microplastics gut microbiome dysbiosis immunity site:gut.bmj.com OR site:nature.com", "microplastics reproductive health fetal exposure site:thelancet.com",
      "microplastics impact on brain neurological disorders site:sciencedirect.com", "microplastics and chronic disease cancer diabetes cardiovascular site:who.int",
      "microplastics linked to erectile dysfunction antibiotic resistance superbugs", "food contamination microplastics seafood produce packaging site:efsa.europa.eu",
      "airborne microplastics indoor exposure site:epa.gov OR site:pubmed.ncbi.nlm.nih.gov", "textiles cosmetics furniture microplastic emissions site:echa.europa.eu",
      "wellness industry microplastics awareness detox contradictions site:gwi.org", "clean living vs microplastic reality wellness narrative site:mindbodygreen.com OR site:wellandgood.com",
      "microplastics detox evidence probiotics antioxidants site:ncbi.nlm.nih.gov", "individual microplastic exposure reduction tips 2025 site:cdc.gov OR site:who.int",
      "new technologies microplastic removal blood purification 2025", "probiotic and antioxidant strategies microplastic detox site:sciencedirect.com",
      "wellness program standards to reduce microplastic exposure site:spaindustry.org", "2025 microplastic research priorities wellness industry site:gwi.org OR site:nih.gov",
      "call to action microplastics wellness sustainability site:globalwellnesssummit.com", "research gaps in microplastic and human health site:thelancet.com OR site:who.int"
  ];
  if (req.method === 'GET') {
    let totalAddedByCron = 0;
    for (const query of searchQueries) {
      const result = await processQueryAndSave(query);
      if (result.status === 'success') totalAddedByCron += result.count;
    }
    return res.status(200).json({ message: 'Cron fetch cycle completed.', totalAdded: totalAddedByCron });
  } else if (req.method === 'POST') {
    let { queryIndex } = req.body;
    if (typeof queryIndex !== 'number' || queryIndex < 0 || queryIndex >= searchQueries.length) {
      return res.status(400).json({ error: 'Invalid queryIndex provided.' });
    }
    const result = await processQueryAndSave(searchQueries[queryIndex]);
    if (result.status === 'success') {
      const nextIndex = (queryIndex + 1 < searchQueries.length) ? queryIndex + 1 : null;
      return res.status(200).json({ message: `Query ${queryIndex + 1}/${searchQueries.length} processed.`, addedCount: result.count, nextIndex: nextIndex });
    } else {
      return res.status(500).json({ error: 'Failed to process query.', details: result.error });
    }
  } else {
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }
});

app.post('/api/batch-update-stories', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { batch_size = 2, continue_token } = req.body;
  try {
    let query = supabase.from('latest_news').select('*').is('ai_image_url', null);
    if (continue_token) {
      query = query.gt('id', continue_token);
    }
    query = query.order('id', { ascending: true }).limit(batch_size);
    const { data: stories, error } = await query;
    if (error) throw error;
    if (!stories || stories.length === 0) {
      return res.status(200).json({ message: 'No more stories to update.', done: true });
    }
    const results = [];
    let lastProcessedId = null;
    for (const story of stories) {
      lastProcessedId = story.id;
      let updates = {};
      let wasUpdated = false;
      const new_ai_summary = await summarizeText(story.title, story.snippet);
      if (new_ai_summary) {
        updates.ai_summary = new_ai_summary;
        wasUpdated = true;
      }
      const new_ai_image_url = await generateAndStoreImage(story.title, story.url);
      if (new_ai_image_url) {
        updates.ai_image_url = new_ai_image_url;
        wasUpdated = true;
      }
      if (wasUpdated) {
        updates.processed_at = new Date().toISOString();
        const { error: updateError } = await supabase.from('latest_news').update(updates).eq('id', story.id);
        if (updateError) {
          results.push({ id: story.id, success: false, message: updateError.message });
        } else {
          results.push({ id: story.id, success: true, updates: Object.keys(updates) });
        }
      } else {
        results.push({ id: story.id, success: true, message: 'No updates applied' });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return res.status(200).json({
      message: `Processed ${stories.length} stories`,
      results,
      continue_token: lastProcessedId,
      done: stories.length < batch_size
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error processing batch.', details: error.message });
  }
});

app.post('/api/regenerate-image', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { article_id } = req.body;
  if (!article_id) {
    return res.status(400).json({ error: 'Missing article_id.' });
  }
  try {
    const { data: story, error: fetchError } = await supabase.from('latest_news').select('id, title, url').eq('id', article_id).single();
    if (fetchError) throw fetchError;
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    const new_ai_image_url = await generateAndStoreImage(story.title, story.url);
    if (!new_ai_image_url) return res.status(500).json({ error: 'Image generation failed.' });
    const { error: updateError } = await supabase.from('latest_news').update({ ai_image_url: new_ai_image_url, processed_at: new Date().toISOString() }).eq('id', article_id);
    if (updateError) throw updateError;
    return res.status(200).json({ message: `Image regenerated successfully for story ID: ${article_id}.`, new_ai_image_url });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error regenerating image.', details: error.message });
  }
});

// --- Start of Correct Email Checking Logic ---

let gmailProcessorMain;
try {
    const gmailProcessorModule = require('../scripts/gmail-processor/index.js');
    if (gmailProcessorModule && typeof gmailProcessorModule.main === 'function') {
        gmailProcessorMain = gmailProcessorModule.main;
        console.log("[API] Successfully loaded gmail-processor module.");
    } else {
        console.error("[API] Failed to load gmail-processor: 'main' is not a function or module is invalid.");
        gmailProcessorMain = null;
    }
} catch (error) {
    console.error("[API] CRITICAL: Failed to require gmail-processor script.", error);
    gmailProcessorMain = null;
}

app.get('/api/cron/check-emails', async (req, res) => {
    const expectedSecret = process.env.CRON_TRIGGER_SECRET;
    const receivedSecret = req.headers['x-custom-cron-secret'];
    if (!expectedSecret || receivedSecret !== expectedSecret) {
        return res.status(401).send('Unauthorized');
    }
    if (!gmailProcessorMain) {
        return res.status(500).json({ message: 'Email processing script not available.' });
    }
    try {
        const processingResult = await gmailProcessorMain();
        return res.status(200).json(processingResult);
    } catch (error) {
        return res.status(500).json({ message: 'Error during email check process.', details: error.message });
    }
});

app.get('/api/admin/check-submitted-emails', async (req, res) => {
    if (!gmailProcessorMain) {
        return res.status(500).json({ message: 'Email processing script not available. Backend issue.' });
    }
    try {
        // Pass the function directly to the main gmail processor
        const processingResult = await gmailProcessorMain(processSubmittedUrl);
        return res.status(200).json(processingResult);
    } catch (error) {
        return res.status(500).json({ message: 'Error during email check process on admin trigger.', details: error.message });
    }
});

app.post('/api/admin/start-email-check', (req, res) => {
    if (!gmailProcessorMain) {
        return res.status(500).json({ message: 'Email processing script not available. Backend issue.' });
    }

    // Immediately respond to the client
    res.status(202).json({ message: 'Email processing job started. Check server logs for progress.' });

    // On the next tick of the event loop, start the actual processing.
    // This ensures the response is sent before the heavy work begins.
    setTimeout(() => {
        gmailProcessorMain(processSubmittedUrl).then(processingResult => {
            console.log('[Asynchronous Email Check] Processing complete.', processingResult);
        }).catch(error => {
            console.error('[Asynchronous Email Check] An error occurred during the background process.', error);
        });
    }, 0);
});

/**
 * Temporary endpoint to reset the email checker's state in Supabase.
 * Deletes the 'last_email_check_uid' and 'last_email_check_timestamp' keys.
 */
app.get('/api/admin/reset-email-checker', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not available.' });
    }
    try {
        console.log('[ADMIN] Attempting to reset email checker state...');
        
        const { error: deleteUidError } = await supabase
            .from('script_metadata')
            .delete()
            .eq('key', 'last_email_check_uid');

        if (deleteUidError) {
            console.error('Error deleting last_email_check_uid:', deleteUidError.message);
        }

        const { error: deleteTimestampError } = await supabase
            .from('script_metadata')
            .delete()
            .eq('key', 'last_email_check_timestamp');
        
        if (deleteTimestampError) {
            console.error('Error deleting last_email_check_timestamp:', deleteTimestampError.message);
        }

        if (deleteUidError || deleteTimestampError) {
            // Even if there's an error, it might be because the key doesn't exist, which is fine.
            // We'll send a success message but log the errors if they occurred.
            console.log('[ADMIN] Email checker state reset completed (with potential non-critical errors).');
            return res.status(200).json({ message: 'Email checker state has been reset. Note: one or more keys may not have existed, which is normal.' });
        }

        console.log('[ADMIN] Email checker state successfully reset.');
        res.status(200).json({ message: 'Email checker has been reset. The next check will start from the last 24 hours.' });

    } catch (error) {
        console.error('[ADMIN] Critical error in /api/admin/reset-email-checker:', error);
        res.status(500).json({ error: 'An unexpected server error occurred.', details: error.message });
    }
});

// --- New Endpoint for Failed URLs ---
app.get('/api/admin/failed-urls', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not available.' });
    }
    try {
        const { data, error } = await supabase
            .from('failed_urls')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('[API] Error fetching failed URLs:', error.message);
            return res.status(500).json({ error: 'Database error fetching failed URLs.', details: error.message });
        }

        res.status(200).json(data || []);

    } catch (error) {
        console.error('[API] Critical error in /api/admin/failed-urls:', error);
        res.status(500).json({ error: 'An unexpected server error occurred.', details: error.message });
    }
});
// --- End of New Endpoint ---

// --- End of Correct Email Checking Logic ---

// Other endpoints from the original file...
app.post('/api/whitepaper-signup', async (req, res) => {
  // ...
});
app.post('/api/contact', async (req, res) => {
  // ...
});
app.post('/api/submit-article-url', async (req, res) => {
    const { url } = req.body;
    const result = await processSubmittedUrl(url);
    res.status(result.status || 500).json(result);
});

module.exports = app;

// --- Start Server for Persistent Environments (like Railway) ---
// This block allows the app to be run as a standalone server
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}