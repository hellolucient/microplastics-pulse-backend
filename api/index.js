require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); 
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { postSingleTweet } = require('../lib/twitterService');
const { runScheduledTasks, runEmailCheck } = require('../lib/automation');
const {
  supabase,
  processQueryAndSave,
  generateTweetPreview,
  SEARCH_QUERIES,
  fetchArticleDetails,
  processSubmittedUrl,
  fetchArticlesFromGoogle,
  summarizeText,
  generateAndStoreImage
} = require('../lib/coreLogic');

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
    if (allowedOrigins.some(allowed => 
        (typeof allowed === 'string' && allowed === origin) || 
        (allowed instanceof RegExp && allowed.test(origin))
    )) {
      return callback(null, true);
    }
    return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
  }
}));

// --- API Endpoints ---
app.get('/api', (req, res) => res.send('Microplastics Pulse Backend API is running!'));

app.post('/api/add-news', async (req, res) => {
    // Check database availability
    if (!supabase) return res.status(503).json({ 
        error: 'Database client not available.',
        details: 'The database connection is not initialized. Please try again later.',
        code: 'DB_UNAVAILABLE'
    });

    const { url } = req.body;
    
    // Validate URL
    if (!url) {
        return res.status(400).json({ 
            error: 'Missing URL.',
            details: 'Please provide a URL to process.',
            code: 'URL_MISSING'
        });
    }
    
    if (!url.startsWith('http')) {
        return res.status(400).json({ 
            error: 'Invalid URL format.',
            details: 'URL must start with http:// or https://',
            code: 'URL_INVALID_FORMAT'
        });
    }

    try {
        // Check for existing URL
        const { data: existing } = await supabase.from('latest_news').select('url').eq('url', url).maybeSingle();
        if (existing) return res.status(409).json({ 
            error: 'URL already exists.',
            details: 'This article has already been processed and exists in our database.',
            code: 'URL_DUPLICATE'
        });
                // First try to resolve the URL if it's a shortened/share URL
        let resolvedUrl = url;
        if (url.includes('share.google') || url.includes('goo.gl') || url.includes('bit.ly') || url.includes('t.co')) {
            try {
                console.log(`[Manual Submission] Resolving shortened URL: ${url}`);
                
                // For Google share URLs, use GET request to follow redirects
                const response = await axios.get(url, { 
                    timeout: 15000, 
                    maxRedirects: 15 // Let it follow all redirects without content limits
                });
                
                // Get the final redirected URL
                resolvedUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || url;
                
                console.log(`[Manual Submission] URL resolved: ${url} -> ${resolvedUrl}`);
            } catch (resolveError) {
                console.warn(`[Manual Submission] Could not resolve URL ${url}, using original. Error: ${resolveError.message}`);
            }
        }

        // Fetch article metadata from Google
        const googleResponse = await fetchArticlesFromGoogle(resolvedUrl, 1);
        if (!googleResponse.success) {
            if (googleResponse.error?.status === 429) {
                return res.status(429).json({ 
                    error: 'Rate limit exceeded.',
                    details: 'Too many requests to Google API. Please try again in a few minutes.',
                    code: 'GOOGLE_RATE_LIMIT'
                });
            }
            return res.status(500).json({ 
                error: 'Google API communication error.',
                details: googleResponse.error?.message || 'Failed to fetch article metadata from Google.',
                code: 'GOOGLE_API_ERROR'
            });
        }

        const searchResults = googleResponse.articles;
        if (!searchResults || searchResults.length === 0) {
            return res.status(404).json({ 
                error: 'Article not found.',
                details: 'Could not find article metadata via Google Search. The article might be too new or not indexed.',
                code: 'ARTICLE_NOT_FOUND'
            });
        }

        const articleData = searchResults[0];
        const sourceHostname = new URL(url).hostname;

        try {
            // Generate AI summary
            const ai_summary = await summarizeText(articleData.title, articleData.snippet);
            if (!ai_summary) {
                return res.status(500).json({ 
                    error: 'AI summary generation failed.',
                    details: 'Failed to generate article summary using AI.',
                    code: 'AI_SUMMARY_FAILED'
                });
            }

            // Generate AI image
            const ai_image_url = await generateAndStoreImage(articleData.title, articleData.link);
            if (!ai_image_url) {
                return res.status(500).json({ 
                    error: 'AI image generation failed.',
                    details: 'Failed to generate or store article image.',
                    code: 'AI_IMAGE_FAILED'
                });
            }

            // Prepare and insert new item
            const newItem = { 
                url: articleData.link, 
                title: articleData.title, 
                ai_summary, 
                ai_image_url, 
                source: sourceHostname, 
                processed_at: new Date().toISOString() 
            };

            const { error: insertError } = await supabase.from('latest_news').insert(newItem);
            if (insertError) {
                if (insertError.code === '23505') {
                    return res.status(409).json({ 
                        error: 'URL already exists.',
                        details: 'This article was added by another process while we were processing it.',
                        code: 'URL_DUPLICATE_RACE'
                    });
                }
                throw insertError;
            }

            return res.status(201).json({ 
                message: 'Article processed successfully.',
                data: newItem,
                code: 'SUCCESS'
            });

        } catch (error) {
            console.error('Error processing article:', error);
            return res.status(500).json({ 
                error: 'Internal server error.',
                details: error.message || 'An unexpected error occurred while processing the article.',
                code: error.code || 'INTERNAL_ERROR'
            });
        }
    } catch (error) {
        console.error('Error in add-news endpoint:', error);
        return res.status(500).json({ 
            error: 'Internal server error.',
            details: error.message || 'An unexpected error occurred while processing the request.',
            code: error.code || 'INTERNAL_ERROR'
        });
    }
});

app.get('/api/search-queries', (req, res) => {
  res.status(200).json({ queries: SEARCH_QUERIES });
});

// --- Failed URLs Management ---
app.get('/api/admin/failed-urls', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });

  try {
    const { data, error } = await supabase
      .from('failed_email_urls')
      .select('*')
      .is('resolved_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      failedUrls: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching failed URLs:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch failed URLs.',
      details: error.message
    });
  }
});

app.post('/api/admin/failed-urls/clear', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Invalid or missing URLs array.' });
  }

  try {
    const { error } = await supabase
      .from('failed_email_urls')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_status: 'manually_cleared'
      })
      .in('url', urls)
      .is('resolved_at', null);

    if (error) throw error;

    return res.status(200).json({
      message: `Successfully cleared ${urls.length} failed URL(s).`,
      clearedUrls: urls
    });
  } catch (error) {
    console.error('Error clearing failed URLs:', error);
    return res.status(500).json({ 
      error: 'Failed to clear URLs.',
      details: error.message
    });
  }
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

app.get('/api/admin/automation-logs', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
    try {
        const { data, error } = await supabase
            .from('automation_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(3); // Get the 3 most recent logs

        if (error) throw error;
        
        res.setHeader('Cache-Control', 'no-store'); // Ensure fresh data
        res.status(200).json(data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch automation logs.', details: error.message });
    }
});

app.all('/api/trigger-fetch', async (req, res) => {
  try {
    // Set a response timeout to prevent hanging
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        console.error('[trigger-fetch] Request timeout after 110 seconds');
        res.status(504).json({ 
          error: 'Request timeout', 
          details: 'Query processing took too long. The query may still be running in the background.' 
        });
      }
    }, 110000); // 110 second timeout (Railway has 120s limit)

    if (req.method === 'GET') {
      let totalAddedByCron = 0;
      for (const query of SEARCH_QUERIES) {
        const result = await processQueryAndSave(query);
        if (result.status === 'success') totalAddedByCron += result.count;
      }
      clearTimeout(timeout);
      return res.status(200).json({ message: 'Cron fetch cycle completed.', totalAdded: totalAddedByCron });
    } else if (req.method === 'POST') {
      let { queryIndex } = req.body;
      if (typeof queryIndex !== 'number' || queryIndex < 0 || queryIndex >= SEARCH_QUERIES.length) {
        clearTimeout(timeout);
        return res.status(400).json({ error: 'Invalid queryIndex provided.' });
      }
      
      console.log(`[trigger-fetch] Processing query ${queryIndex + 1}/${SEARCH_QUERIES.length}: "${SEARCH_QUERIES[queryIndex]}"`);
      const result = await processQueryAndSave(SEARCH_QUERIES[queryIndex]);
      clearTimeout(timeout);
      
      if (result.status === 'success') {
        const nextIndex = (queryIndex + 1 < SEARCH_QUERIES.length) ? queryIndex + 1 : null;
        return res.status(200).json({ 
          message: `Query ${queryIndex + 1}/${SEARCH_QUERIES.length} processed.`, 
          addedCount: result.count, 
          nextIndex: nextIndex 
        });
      } else {
        console.error(`[trigger-fetch] Query ${queryIndex + 1} failed:`, result);
        return res.status(500).json({ 
          error: 'Failed to process query.', 
          details: result.status,
          queryIndex: queryIndex
        });
      }
    } else {
      clearTimeout(timeout);
      return res.status(405).json({ error: `Method ${req.method} not allowed.` });
    }
  } catch (error) {
    console.error('[trigger-fetch] Unexpected error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message 
      });
    }
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

app.post('/api/admin/check-emails', async (req, res) => {
  console.log("[API] Received request to /api/admin/check-emails");
  
  // Check if required environment variables are set
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error("[API] Email check failed: Missing email credentials");
    return res.status(500).json({
      error: 'Email configuration missing',
      details: 'Email credentials are not properly configured on the server.',
      code: 'EMAIL_CONFIG_MISSING'
    });
  }

  if (!supabase) {
    console.error("[API] Email check failed: Supabase client not available");
    return res.status(503).json({
      error: 'Database client not available',
      details: 'The database connection is not initialized.',
      code: 'DB_UNAVAILABLE'
    });
  }

  try {
    console.log("[API] Starting email check with credentials:", { 
      user: process.env.EMAIL_USER,
      hasPassword: !!process.env.EMAIL_PASS
    });

    const result = await runEmailCheck();
    console.log("[API] Email check completed successfully:", result);
    res.status(200).json(result);
  } catch (error) {
    console.error("[API] Error during manual email check:", error);
    
    // Determine the specific error type
    let statusCode = 500;
    let errorResponse = {
      error: 'Failed to execute email check',
      details: error.message,
      code: 'UNKNOWN_ERROR'
    };

    if (error.code === 'EAUTH') {
      statusCode = 401;
      errorResponse = {
        error: 'Email authentication failed',
        details: 'Failed to authenticate with Gmail. Please check email credentials.',
        code: 'EMAIL_AUTH_FAILED'
      };
    } else if (error.code === 'ETIMEDOUT') {
      statusCode = 504;
      errorResponse = {
        error: 'Connection timeout',
        details: 'Connection to Gmail timed out. Please try again.',
        code: 'EMAIL_TIMEOUT'
      };
    } else if (error.code === 'ECONNREFUSED') {
      statusCode = 503;
      errorResponse = {
        error: 'Connection refused',
        details: 'Could not connect to Gmail server. Please try again later.',
        code: 'EMAIL_CONNECTION_FAILED'
      };
    }

    res.status(statusCode).json(errorResponse);
  }
});

// Determine the cron schedule from environment variables, with a default.
// The default '0 */8 * * *' runs every 8 hours (e.g., at 00:00, 08:00, 16:00).
const cronSchedule = process.env.CRON_SCHEDULE || '0 */8 * * *'; 

// --- Scheduled Tasks ---
console.log(`[Scheduler] Setting up cron job with schedule: "${cronSchedule}"`);
cron.schedule(cronSchedule, () => {
    console.log('[Scheduler] Triggering scheduled tasks due to schedule.');
    runScheduledTasks();
});

// Immediately run tasks on startup for testing in dev environments
if (process.env.NODE_ENV !== 'production') {
  // ... existing code ...
}

// --- Server Initialization ---
app.listen(process.env.PORT || 3001, () => {
    console.log(`Backend server listening on port ${process.env.PORT || 3001}`);
});

module.exports = { app };