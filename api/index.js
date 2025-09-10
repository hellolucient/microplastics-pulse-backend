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

// Add chat routes
const chatRoutes = require('./admin/chat');

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

// Add chat routes
app.use('/api/admin/chat', chatRoutes);

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
        // Use the enhanced URL resolver first
        const { resolveGoogleShareUrl } = require('../lib/coreLogic');
        const resolvedUrl = await resolveGoogleShareUrl(url);
        
        console.log(`[Manual Submission] URL resolution: ${url} -> ${resolvedUrl}`);
        
        // Check for existing URL using the resolved URL
        console.log(`[Manual Submission] Checking database for URL: ${resolvedUrl}`);
        
        // Let's also check what the exact query looks like
        console.log(`[Manual Submission] Executing query: SELECT url FROM latest_news WHERE url = '${resolvedUrl}'`);
        
        const { data: existing, error: queryError } = await supabase.from('latest_news').select('url').eq('url', resolvedUrl).maybeSingle();
        
        console.log(`[Manual Submission] Database query result:`, { existing, queryError });
        console.log(`[Manual Submission] existing is truthy:`, !!existing);
        console.log(`[Manual Submission] existing type:`, typeof existing);
        console.log(`[Manual Submission] existing value:`, existing);
        
        // Additional debugging: Check for similar URLs
        const { data: similarUrls } = await supabase
            .from('latest_news')
            .select('url')
            .like('url', '%denverpost.com%')
            .limit(3);
        console.log(`[Manual Submission] Similar Denver Post URLs in DB:`, similarUrls);
        
        const { data: shareUrls } = await supabase
            .from('latest_news')
            .select('url')
            .like('url', '%share.google%')
            .limit(3);
        console.log(`[Manual Submission] Google Share URLs in DB:`, shareUrls);
        
        // Let's also check if the specific resolved URL exists with a different query
        const { data: directCheck } = await supabase
            .from('latest_news')
            .select('id, url, title')
            .eq('url', resolvedUrl);
        console.log(`[Manual Submission] Direct check for resolved URL:`, directCheck);
        
        // And let's check if there are any URLs containing the query parameter
        const { data: queryParamCheck } = await supabase
            .from('latest_news')
            .select('id, url, title')
            .like('url', '%WWJynWQncwsu1Q42i%');
        console.log(`[Manual Submission] URLs containing query param:`, queryParamCheck);
        
        if (queryError) {
            console.error(`[Manual Submission] Database query error:`, queryError);
            return res.status(500).json({ 
                error: 'Database query error.',
                details: queryError.message,
                code: 'DB_QUERY_ERROR'
            });
        }
        
        if (existing) {
            console.log(`[Manual Submission] Found existing URL in database:`, existing);
            return res.status(409).json({ 
            error: 'URL already exists.',
            details: 'This article has already been processed and exists in our database.',
            code: 'URL_DUPLICATE'
        });
        } else {
            console.log(`[Manual Submission] URL not found in database, proceeding with processing`);
        }

        // Try to fetch article metadata directly from the resolved URL
        let articleData;
        let response;
        try {
            console.log(`[Manual Submission] Attempting to fetch article content directly from: ${resolvedUrl}`);
            response = await axios.get(resolvedUrl, { 
                    timeout: 15000, 
                maxRedirects: 5, // Allow some redirects but not too many
                validateStatus: null, // Accept all status codes including 403
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Cache-Control': 'max-age=0',
                    'DNT': '1',
                    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"macOS"'
                }
            });
            
            const html = response.data;
            
            // Check if we got a blocked/denied page
            if (html.includes('Access to this page has been denied') || 
                html.includes('Access Denied') || 
                html.includes('403 Forbidden') ||
                html.includes('Blocked') ||
                html.includes('bot detection') ||
                html.includes('Cloudflare')) {
                console.log(`[Manual Submission] Page appears to be blocked/denied, falling back to Google Search`);
                throw new Error('Page blocked/denied - access restricted');
            }
            
            // Extract title from HTML - try multiple methods
            let title = 'Article Title Not Found';
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || 
                              html.match(/<meta[^>]*property=['\"]og:title['\"][^>]*content=['\"]([^'\"]+)['\"][^>]*>/i) ||
                              html.match(/<meta[^>]*name=['\"]title['\"][^>]*content=['\"]([^'\"]+)['\"][^>]*>/i) ||
                              html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
            
            if (titleMatch) {
                title = titleMatch[1].trim()
                    .replace(/&#x27;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&quot;/g, '"')
                    .replace(/&ldquo;/g, '"')
                    .replace(/&rdquo;/g, '"')
                    .replace(/&lsquo;/g, "'")
                    .replace(/&rsquo;/g, "'")
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&nbsp;/g, ' ')
                    // Remove HTML tags and convert to plain text
                    .replace(/<em>/g, '').replace(/<\/em>/g, '')
                    .replace(/<strong>/g, '').replace(/<\/strong>/g, '')
                    .replace(/<b>/g, '').replace(/<\/b>/g, '')
                    .replace(/<i>/g, '').replace(/<\/i>/g, '')
                    .replace(/<u>/g, '').replace(/<\/u>/g, '');
            }
            
            // Extract description/snippet from HTML - try multiple methods
            let snippet = 'Article description not available';
            const descMatch = html.match(/<meta[^>]*property=['\"]og:description['\"][^>]*content=['\"]([^'\"]+)['\"][^>]*>/i) ||
                             html.match(/<meta[^>]*name=['\"]description['\"][^>]*content=['\"]([^'\"]+)['\"][^>]*>/i) ||
                             html.match(/<meta[^>]*property=['\"]twitter:description['\"][^>]*content=['\"]([^'\"]+)['\"][^>]*>/i);
            
            if (descMatch) {
                snippet = descMatch[1].trim()
                    .replace(/&#x27;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&quot;/g, '"')
                    .replace(/&ldquo;/g, '"')
                    .replace(/&rdquo;/g, '"')
                    .replace(/&lsquo;/g, "'")
                    .replace(/&rsquo;/g, "'")
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&nbsp;/g, ' ')
                    // Remove HTML tags and convert to plain text
                    .replace(/<em>/g, '').replace(/<\/em>/g, '')
                    .replace(/<strong>/g, '').replace(/<\/strong>/g, '')
                    .replace(/<b>/g, '').replace(/<\/b>/g, '')
                    .replace(/<i>/g, '').replace(/<\/i>/g, '')
                    .replace(/<u>/g, '').replace(/<\/u>/g, '');
            } else {
                // Fallback: Try to extract first paragraph or summary from article body
                const paragraphMatch = html.match(/<p[^>]*>([^<]+)<\/p>/i) ||
                                     html.match(/<div[^>]*class=['\"][^'\"]*summary[^'\"]*['\"][^>]*>([^<]+)<\/div>/i) ||
                                     html.match(/<div[^>]*class=['\"][^'\"]*excerpt[^'\"]*['\"][^>]*>([^<]+)<\/div>/i);
                
                if (paragraphMatch) {
                    snippet = paragraphMatch[1].trim()
                        .replace(/&#x27;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&quot;/g, '"')
                        .replace(/&ldquo;/g, '"')
                        .replace(/&rdquo;/g, '"')
                        .replace(/&lsquo;/g, "'")
                        .replace(/&rsquo;/g, "'")
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&nbsp;/g, ' ')
                        // Remove HTML tags and convert to plain text
                        .replace(/<em>/g, '').replace(/<\/em>/g, '')
                        .replace(/<strong>/g, '').replace(/<\/strong>/g, '')
                        .replace(/<b>/g, '').replace(/<\/b>/g, '')
                        .replace(/<i>/g, '').replace(/<\/i>/g, '')
                        .replace(/<u>/g, '').replace(/<\/u>/g, '')
                        // Limit length to reasonable snippet size
                        .substring(0, 200);
                }
            }
            
            // Check if we got a Cloudflare or bot protection page
            if (title === 'Just a moment...' || 
                title.toLowerCase().includes('cloudflare') ||
                title.toLowerCase().includes('checking your browser') ||
                title.toLowerCase().includes('please wait') ||
                html.includes('Cloudflare') ||
                html.includes('cf-challenge') ||
                html.includes('Just a moment')) {
                
                console.log(`[Manual Submission] Detected Cloudflare/bot protection page, throwing error to trigger Google Search fallback`);
                throw new Error('Cloudflare protection detected');
            }
            
            articleData = {
                title: title,
                link: resolvedUrl,
                snippet: snippet
            };
            
            console.log(`[Manual Submission] Successfully extracted article data: "${title}"`);
            
        } catch (directFetchError) {
            console.log(`[Manual Submission] Direct fetch failed, trying Google Search as fallback: ${directFetchError.message}`);
            
            // Check if we got a Cloudflare or similar protection page
            if (response && response.status === 403 && response.data && response.data.includes('Cloudflare')) {
                console.log(`[Manual Submission] Detected Cloudflare protection, using enhanced Google Search fallback`);
            }
            
            // Enhanced fallback: Try multiple Google Search strategies
            let googleResponse;
            
            // Strategy 1: Search for the exact URL
            googleResponse = await fetchArticlesFromGoogle(resolvedUrl, 1);
            
            // Strategy 2: If that fails, try searching for the domain + keywords from URL
            if (!googleResponse.success || !googleResponse.articles || googleResponse.articles.length === 0) {
                console.log(`[Manual Submission] Exact URL search failed, trying domain-based search`);
                const urlObj = new URL(resolvedUrl);
                const domain = urlObj.hostname;
                const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
                const searchQuery = `site:${domain} ${pathParts.slice(-2).join(' ')}`;
                googleResponse = await fetchArticlesFromGoogle(searchQuery, 1);
            }
            
            // Strategy 3: If that fails, try a broader domain search
            if (!googleResponse.success || !googleResponse.articles || googleResponse.articles.length === 0) {
                console.log(`[Manual Submission] Domain search failed, trying broader site search`);
                const urlObj = new URL(resolvedUrl);
                const domain = urlObj.hostname;
                googleResponse = await fetchArticlesFromGoogle(`site:${domain}`, 1);
            }
            
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

            articleData = searchResults[0];
        }

        const sourceHostname = new URL(resolvedUrl).hostname;

        // Debug: Log the article data we received
        console.log(`[Manual Submission] Article data received:`, {
            title: articleData.title,
            titleLength: articleData.title?.length,
            snippet: articleData.snippet,
            snippetLength: articleData.snippet?.length,
            link: articleData.link
        });

        // Validate article data before processing
        if (!articleData.title || 
            articleData.title === 'Article Title Not Found' || 
            articleData.title.trim().length < 3 ||
            !articleData.snippet || 
            articleData.snippet === 'Article description not available' ||
            articleData.snippet.trim().length < 5) {
            
            console.log(`[Manual Submission] Invalid article data - skipping processing:`, {
                title: articleData.title,
                titleLength: articleData.title?.length,
                snippet: articleData.snippet,
                snippetLength: articleData.snippet?.length
            });
            
            return res.status(400).json({ 
                error: 'Invalid article data.',
                details: 'Article title or description is missing, too short, or invalid. Cannot process incomplete articles.',
                code: 'INVALID_ARTICLE_DATA'
            });
        }

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

// New endpoint specifically for articles missing ai_summary
app.post('/api/batch-generate-summaries', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { batch_size = 2, continue_token, article_ids } = req.body;
  
  try {
    let query;
    
    // If specific article IDs provided, use those
    if (article_ids && article_ids.length > 0) {
      query = supabase.from('latest_news').select('*').in('id', article_ids).is('ai_summary', null);
    } else {
      // Otherwise, find articles without summaries
      query = supabase.from('latest_news').select('*').is('ai_summary', null);
      if (continue_token) {
        query = query.gt('id', continue_token);
      }
      query = query.order('id', { ascending: true }).limit(batch_size);
    }
    
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
      
      // Generate AI summary using title and snippet
      const new_ai_summary = await summarizeText(story.title, story.snippet);
      if (new_ai_summary) {
        updates.ai_summary = new_ai_summary;
        updates.processed_at = new Date().toISOString();
        wasUpdated = true;
      }
      
      if (wasUpdated) {
        const { error: updateError } = await supabase.from('latest_news').update(updates).eq('id', story.id);
        if (updateError) {
          results.push({ id: story.id, success: false, message: updateError.message });
        } else {
          results.push({ id: story.id, success: true, updates: Object.keys(updates) });
        }
      } else {
        results.push({ id: story.id, success: false, message: 'Failed to generate summary' });
      }
      
      // 2-second delay between articles to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return res.status(200).json({
      message: `Processed ${stories.length} stories for summary generation`,
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

// Batch image generation endpoint
app.post('/api/batch-generate-images', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  const { batch_size = 2, continue_token, article_ids } = req.body;

  try {
    let query;

    // If specific article IDs provided, use those
    if (article_ids && article_ids.length > 0) {
      query = supabase.from('latest_news').select('*').in('id', article_ids).is('ai_image_url', null);
    } else {
      // Otherwise, find articles without images
      query = supabase.from('latest_news').select('*').is('ai_image_url', null);
      if (continue_token) {
        query = query.gt('id', continue_token);
      }
      query = query.order('id', { ascending: true }).limit(batch_size);
    }

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

      // Generate AI image
      const new_ai_image_url = await generateAndStoreImage(story.title, story.url);
      if (new_ai_image_url) {
        updates.ai_image_url = new_ai_image_url;
        updates.processed_at = new Date().toISOString();
        wasUpdated = true;
      }

      if (wasUpdated) {
        const { error: updateError } = await supabase.from('latest_news').update(updates).eq('id', story.id);
        if (updateError) {
          results.push({ id: story.id, success: false, message: updateError.message });
        } else {
          results.push({ id: story.id, success: true, updates: Object.keys(updates) });
        }
      } else {
        results.push({ id: story.id, success: false, message: 'Failed to generate image' });
      }

      // 3-second delay between images to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    return res.status(200).json({
      message: `Processed ${stories.length} stories for image generation`,
      results,
      continue_token: lastProcessedId,
      done: stories.length < batch_size
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal server error processing batch.', details: error.message });
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

// --- Email Collection Endpoint ---
app.post('/api/collect-email', async (req, res) => {
  console.log("[API] Received email collection request");
  
  const { email, source = 'whitepaper_download' } = req.body;
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({
      error: 'Invalid email address',
      details: 'Please provide a valid email address.'
    });
  }

  try {
    // Check if email already exists in whitepaper_leads table
    const { data: existing, error: checkError } = await supabase
      .from('whitepaper_leads')
      .select('id, created_at')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (checkError) {
      console.error("[API] Error checking for existing email:", checkError.message);
      return res.status(500).json({
        error: 'Database error',
        details: 'Unable to process request at this time.'
      });
    }

    if (existing) {
      console.log(`[API] Email already exists in whitepaper_leads: ${email}`);
      return res.status(200).json({
        message: 'Email already registered',
        isNewSubscriber: false,
        subscriberId: existing.id
      });
    }

    // Insert new email into whitepaper_leads table
    const { data: newLead, error: insertError } = await supabase
      .from('whitepaper_leads')
      .insert({
        email: email.toLowerCase(),
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (insertError) {
      console.error("[API] Error inserting new email:", insertError.message);
      return res.status(500).json({
        error: 'Email registration failed',
        details: 'Unable to save email at this time.'
      });
    }

    console.log(`[API] New email added to whitepaper_leads: ${email} (ID: ${newLead.id})`);
    return res.status(201).json({
      message: 'Email collected successfully',
      isNewSubscriber: true,
      subscriberId: newLead.id
    });

  } catch (error) {
    console.error("[API] Unexpected error during email collection:", error);
    return res.status(500).json({
      error: 'Server error',
      details: 'An unexpected error occurred. Please try again.'
    });
  }
});

// Determine the cron schedule from environment variables, with a sensible daily default.
// Default '0 2 * * *' runs once daily at 2:00 AM UTC (good for automation)
// Alternative: '0 0 * * *' for midnight UTC
const cronSchedule = process.env.CRON_SCHEDULE || '0 2 * * *'; 

// --- Scheduled Tasks ---
console.log(`[Scheduler] Setting up cron job with schedule: "${cronSchedule}"`);
console.log(`[Scheduler] This translates to: ${cronSchedule === '0 2 * * *' ? 'Daily at 2:00 AM UTC' : 'Custom schedule'}`);

// Add cron job health monitoring
const cronJob = cron.schedule(cronSchedule, async () => {
    console.log('[Scheduler] Triggering scheduled tasks due to schedule.');
    console.log(`[Scheduler] Current UTC time at trigger: ${new Date().toISOString()}`);
    try {
        const result = await runScheduledTasks();
        console.log(`[Scheduler] Scheduled tasks completed with status: ${result.status}`);
    } catch (error) {
        console.error('[Scheduler] CRITICAL ERROR during scheduled tasks:', error);
        // Continue running - don't crash the server
    }
}, {
    scheduled: true,
    timezone: "UTC"
});

// Add startup verification
console.log('[Scheduler] Cron job initialized successfully.');
console.log(`[Scheduler] Current UTC time: ${new Date().toISOString()}`);
console.log(`[Scheduler] Next scheduled run will be determined by: "${cronSchedule}"`);
console.log(`[Scheduler] Cron job running status: ${cronJob.running ? 'RUNNING' : 'STOPPED'}`);

// Add a health check endpoint to verify cron job status
app.get('/api/admin/cron-status', (req, res) => {
    const now = new Date();
    
    // Calculate next run time manually for '0 2 * * *' (2 AM UTC daily)
    const nextRun = new Date(now);
    nextRun.setUTCHours(2, 0, 0, 0); // Set to 2:00 AM UTC
    if (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1); // If 2 AM has passed today, set to tomorrow
    }
    
    res.json({
        currentTime: now.toISOString(),
        cronSchedule: cronSchedule,
        cronJobRunning: cronJob ? cronJob.running : false,
        nextScheduledRun: nextRun.toISOString(),
        serverUptime: process.uptime(),
        timezone: 'UTC',
        appSleepingWarning: 'Railway may put service to sleep after 10min inactivity - cron jobs will not run while sleeping'
    });
});

// Add manual trigger endpoint for testing
app.post('/api/admin/trigger-automation', async (req, res) => {
    try {
        console.log('[Admin] Manual automation trigger requested.');
        const result = await runScheduledTasks();
        
        // runScheduledTasks now returns the final status and report
        const statusCode = result.status === 'SUCCESS' ? 200 : 207; // 207 = Multi-Status (partial success)
        
        res.status(statusCode).json({ 
            message: result.status === 'SUCCESS' 
                ? 'Automation tasks completed successfully.' 
                : 'Automation tasks completed with some issues.',
            status: result.status,
            details: result.report,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[Admin] Error during manual automation trigger:', error);
        res.status(500).json({ 
            error: 'Automation tasks failed completely.',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/admin/check-duplicates', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  
  try {
    console.log('[API] Starting duplicate URL check...');
    
    // Get total count
    const { count, error: countError } = await supabase
      .from('latest_news')
      .select('*', { count: 'exact', head: true });
      
    if (countError) {
      console.error('[API] Error getting count:', countError.message);
      return res.status(500).json({ error: 'Failed to get record count.', details: countError.message });
    }
    
    // Fetch all URLs using pagination
    let allUrls = [];
    const pageSize = 1000;
    let page = 0;
    
    while (true) {
      const { data: pageData, error } = await supabase
        .from('latest_news')
        .select('id, url, processed_at, title')
        .order('processed_at', { ascending: true })
        .range(page * pageSize, (page + 1) * pageSize - 1);
        
      if (error) {
        console.error('[API] Error fetching URLs:', error.message);
        return res.status(500).json({ error: 'Failed to fetch URLs.', details: error.message });
      }
      
      if (!pageData || pageData.length === 0) break;
      
      allUrls.push(...pageData);
      
      if (pageData.length < pageSize) break; // Last page
      page++;
    }
    
    console.log(`[API] Fetched ${allUrls.length} URLs for duplicate analysis`);
    
    // Check for duplicates
    const urlMap = new Map();
    const duplicates = [];
    
    for (const record of allUrls) {
      const url = record.url;
      if (urlMap.has(url)) {
        const original = urlMap.get(url);
        duplicates.push({
          url: url,
          original: original,
          duplicate: record
        });
      } else {
        urlMap.set(url, record);
      }
    }
    
    // Group duplicates by URL for detailed analysis
    const duplicateGroups = new Map();
    for (const dup of duplicates) {
      const url = dup.url;
      if (!duplicateGroups.has(url)) {
        duplicateGroups.set(url, []);
      }
      duplicateGroups.get(url).push(dup);
    }
    
    // Prepare response
    const result = {
      totalRecords: allUrls.length,
      databaseCount: count,
      uniqueUrls: urlMap.size,
      duplicateUrls: duplicates.length,
      duplicatePercentage: ((duplicates.length / allUrls.length) * 100).toFixed(2),
      duplicateGroups: Array.from(duplicateGroups.entries()).map(([url, dups]) => ({
        url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
        occurrences: dups.length + 1,
        originalId: urlMap.get(url).id,
        duplicateIds: dups.map(d => d.duplicate.id)
      })).sort((a, b) => b.occurrences - a.occurrences).slice(0, 10) // Top 10 most duplicated
    };
    
    console.log(`[API] Duplicate check complete: ${duplicates.length} duplicates found`);
    res.status(200).json(result);
    
  } catch (error) {
    console.error('[API] Error during duplicate check:', error.message);
    res.status(500).json({ error: 'Failed to check duplicates.', details: error.message });
  }
});

// Immediately run tasks on startup for testing in dev environments
if (process.env.NODE_ENV !== 'production') {
  // ... existing code ...
}

// --- AI Usage Tracking Endpoints ---

// Get AI usage statistics
app.get('/api/admin/ai-usage-stats', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  
  try {
    const { timeframe = '7d', provider, model } = req.query;
    
    // Calculate date range
    const now = new Date();
    let startDate;
    switch (timeframe) {
      case '1d':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    // Build query
    let query = supabase
      .from('ai_usage_logs')
      .select('*')
      .gte('created_at', startDate.toISOString());
    
    if (provider) query = query.eq('provider', provider);
    if (model) query = query.eq('model', model);
    
    const { data: logs, error } = await query;
    if (error) throw error;
    
    // Calculate statistics
    const stats = {
      totalRequests: logs.length,
      successfulRequests: logs.filter(log => log.success).length,
      failedRequests: logs.filter(log => !log.success).length,
      totalInputTokens: logs.reduce((sum, log) => sum + (log.input_tokens || 0), 0),
      totalOutputTokens: logs.reduce((sum, log) => sum + (log.output_tokens || 0), 0),
      totalTokens: logs.reduce((sum, log) => sum + (log.total_tokens || 0), 0),
      totalCost: logs.reduce((sum, log) => sum + (log.cost_usd || 0), 0),
      avgDuration: logs.length > 0 ? logs.reduce((sum, log) => sum + (log.request_duration_ms || 0), 0) / logs.length : 0,
      providers: [...new Set(logs.map(log => log.provider))],
      models: [...new Set(logs.map(log => log.model))],
      operationTypes: [...new Set(logs.map(log => log.operation_type))],
      dailyBreakdown: {},
      hourlyBreakdown: {},
      providerBreakdown: {},
      modelBreakdown: {},
      operationBreakdown: {}
    };
    
    // Calculate daily breakdown
    logs.forEach(log => {
      const date = new Date(log.created_at).toISOString().split('T')[0];
      if (!stats.dailyBreakdown[date]) {
        stats.dailyBreakdown[date] = { requests: 0, cost: 0, tokens: 0 };
      }
      stats.dailyBreakdown[date].requests++;
      stats.dailyBreakdown[date].cost += log.cost_usd || 0;
      stats.dailyBreakdown[date].tokens += log.total_tokens || 0;
    });
    
    // Calculate hourly breakdown
    logs.forEach(log => {
      const hour = new Date(log.created_at).getHours();
      if (!stats.hourlyBreakdown[hour]) {
        stats.hourlyBreakdown[hour] = { requests: 0, cost: 0, tokens: 0 };
      }
      stats.hourlyBreakdown[hour].requests++;
      stats.hourlyBreakdown[hour].cost += log.cost_usd || 0;
      stats.hourlyBreakdown[hour].tokens += log.total_tokens || 0;
    });
    
    // Calculate provider breakdown
    stats.providers.forEach(provider => {
      const providerLogs = logs.filter(log => log.provider === provider);
      const successfulLogs = providerLogs.filter(log => log.success);
      stats.providerBreakdown[provider] = {
        requests: providerLogs.length,
        cost: providerLogs.reduce((sum, log) => sum + (log.cost_usd || 0), 0),
        tokens: providerLogs.reduce((sum, log) => sum + (log.total_tokens || 0), 0),
        successRate: providerLogs.length > 0 ? (successfulLogs.length / providerLogs.length) * 100 : 0
      };
    });
    
    // Calculate model breakdown
    stats.models.forEach(model => {
      const modelLogs = logs.filter(log => log.model === model);
      stats.modelBreakdown[model] = {
        requests: modelLogs.length,
        cost: modelLogs.reduce((sum, log) => sum + (log.cost_usd || 0), 0),
        tokens: modelLogs.reduce((sum, log) => sum + (log.total_tokens || 0), 0),
        avgDuration: modelLogs.length > 0 ? modelLogs.reduce((sum, log) => sum + (log.request_duration_ms || 0), 0) / modelLogs.length : 0
      };
    });
    
    // Calculate operation breakdown
    stats.operationTypes.forEach(operation => {
      const operationLogs = logs.filter(log => log.operation_type === operation);
      const successfulLogs = operationLogs.filter(log => log.success);
      stats.operationBreakdown[operation] = {
        requests: operationLogs.length,
        cost: operationLogs.reduce((sum, log) => sum + (log.cost_usd || 0), 0),
        tokens: operationLogs.reduce((sum, log) => sum + (log.total_tokens || 0), 0),
        successRate: operationLogs.length > 0 ? (successfulLogs.length / operationLogs.length) * 100 : 0
      };
    });
    
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching AI usage stats:', error);
    res.status(500).json({ error: 'Failed to fetch usage statistics', details: error.message });
  }
});

// Get recent AI usage
app.get('/api/admin/ai-usage-recent', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database client not available.' });
  
  try {
    const { limit = 20, provider, model } = req.query;
    
    let query = supabase
      .from('ai_usage_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));
    
    if (provider) query = query.eq('provider', provider);
    if (model) query = query.eq('model', model);
    
    const { data: logs, error } = await query;
    if (error) throw error;
    
    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    console.error('Error fetching recent AI usage:', error);
    res.status(500).json({ error: 'Failed to fetch recent usage', details: error.message });
  }
});

// Test endpoint for AI logging
app.post('/api/admin/test-ai-logging', async (req, res) => {
  try {
    const { logTextGenerationUsage } = require('../lib/aiUsageLogger');
    
    // Test logging with dummy data
    await logTextGenerationUsage(
      'openai',
      'gpt-3.5-turbo',
      'test',
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      1000,
      true,
      null,
      'test-key'
    );
    
    res.json({ success: true, message: 'Test logging completed' });
  } catch (error) {
    console.error('Test logging error:', error);
    res.status(500).json({ error: 'Test logging failed', details: error.message });
  }
});

// --- Server Initialization ---
app.listen(process.env.PORT || 3001, () => {
    console.log(`Backend server listening on port ${process.env.PORT || 3001}`);
});

module.exports = { app };