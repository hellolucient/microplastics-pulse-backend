require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); 
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const he = require('he');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { postSingleTweet } = require('../lib/twitterService');
const { runScheduledTasks } = require('../lib/automation');
const {
  supabase,
  processQueryAndSave,
  generateTweetPreview,
  SEARCH_QUERIES,
  fetchArticleDetails,
  processSubmittedUrl
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
  res.status(200).json({ queries: SEARCH_QUERIES });
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
  if (req.method === 'GET') {
    let totalAddedByCron = 0;
    for (const query of SEARCH_QUERIES) {
      const result = await processQueryAndSave(query);
      if (result.status === 'success') totalAddedByCron += result.count;
    }
    return res.status(200).json({ message: 'Cron fetch cycle completed.', totalAdded: totalAddedByCron });
  } else if (req.method === 'POST') {
    let { queryIndex } = req.body;
    if (typeof queryIndex !== 'number' || queryIndex < 0 || queryIndex >= SEARCH_QUERIES.length) {
      return res.status(400).json({ error: 'Invalid queryIndex provided.' });
    }
    const result = await processQueryAndSave(SEARCH_QUERIES[queryIndex]);
    if (result.status === 'success') {
      const nextIndex = (queryIndex + 1 < SEARCH_QUERIES.length) ? queryIndex + 1 : null;
      return res.status(200).json({ message: `Query ${queryIndex + 1}/${SEARCH_QUERIES.length} processed.`, addedCount: result.count, nextIndex: nextIndex });
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