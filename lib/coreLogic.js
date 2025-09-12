const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');
const { put } = require('@vercel/blob');
const he = require('he');
const { logTextGenerationUsage, logImageGenerationUsage } = require('./aiUsageLogger');

// --- Initialize Clients ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Constants ---
const SEARCH_QUERIES = [
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

// --- Helper Functions ---

/**
 * Enhanced Google Share URL resolver that handles various redirect scenarios
 * @param {string} url - The URL to resolve
 * @returns {Promise<string>} - The resolved URL
 */
async function resolveGoogleShareUrl(url) {
  if (!url.includes('share.google') && !url.includes('goo.gl') && !url.includes('bit.ly') && !url.includes('t.co')) {
    return url; // Not a shortened URL, return as-is
  }

  console.log(`[URL Resolver] Resolving shortened/share URL: ${url}`);
  
  try {
    // For Google Share URLs, use GET request to follow all redirects
    if (url.includes('share.google')) {
      console.log(`[URL Resolver] Google Share URL detected, using GET to follow all redirects`);
      const getResponse = await axios.get(url, { 
        timeout: 15000, 
        maxRedirects: 10,
        validateStatus: null, // Accept any status code including 403
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
      
      // Get the final redirected URL - try multiple methods
      const resolvedUrl = getResponse.request.res.responseUrl || 
                         getResponse.request._redirectable?._currentUrl || 
                         getResponse.request.res.responseUrl ||
                         url;
      
      if (resolvedUrl !== url) {
        console.log(`[URL Resolver] Resolved via GET: ${url} -> ${resolvedUrl}`);
        return resolvedUrl;
      }
    } else {
      // For other shortened URLs, try HEAD request first (no content download)
      const headResponse = await axios.head(url, { 
        timeout: 15000, 
        maxRedirects: 10,
        validateStatus: null // Accept any status code including 403
      });
      
      // Get the final redirected URL - try multiple methods
      const resolvedUrl = headResponse.request.res.responseUrl || 
                         headResponse.request._redirectable?._currentUrl || 
                         headResponse.request.res.responseUrl ||
                         url;
      
      if (resolvedUrl !== url) {
        console.log(`[URL Resolver] Resolved via HEAD: ${url} -> ${resolvedUrl}`);
        return resolvedUrl;
      }
    }
  } catch (headError) {
    console.log(`[URL Resolver] HEAD failed, trying GET...`);
  }

  try {
    // If HEAD fails, try GET request
    const getResponse = await axios.get(url, { 
      timeout: 15000, 
      maxRedirects: 10,
      validateStatus: null // Accept any status code including 403
    });
    
    // Get the final redirected URL - try multiple methods
    const resolvedUrl = getResponse.request.res.responseUrl || 
                       getResponse.request._redirectable?._currentUrl || 
                       getResponse.request.res.responseUrl ||
                       url;
    
    if (resolvedUrl !== url) {
      console.log(`[URL Resolver] Resolved via GET: ${url} -> ${resolvedUrl}`);
      
      // Additional check: if we got a 403 but the URL changed, that's still success
      if (getResponse.status === 403) {
        console.log(`[URL Resolver] Got 403 but URL redirected successfully: ${resolvedUrl}`);
      }
      
      return resolvedUrl;
    }
  } catch (getError) {
    console.warn(`[URL Resolver] Both HEAD and GET failed for ${url}. Using original URL. Error: ${getError.message}`);
  }

  return url; // Return original URL if resolution fails
}

async function fetchArticlesFromGoogle(query, numResults = 10) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cxId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    const apiUrl = "https://www.googleapis.com/customsearch/v1";
    if (!apiKey || !cxId) {
        return { success: false, error: { message: "Google API Key or CX ID is missing." } };
    }
    const params = { key: apiKey, cx: cxId, q: query, num: numResults };
    try {
        const response = await axios.get(apiUrl, { params, timeout: 20000 });
        if (response.data && response.data.items) {
            const articles = response.data.items.map(item => {
                // Decode HTML entities in title and snippet
                const decodedTitle = item.title
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
                
                const decodedSnippet = item.snippet
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
                
                return { title: decodedTitle, link: item.link, snippet: decodedSnippet };
            });
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
    const prompt = `Generate a detailed summary of the article titled "${title}" with the provided snippet: "${snippet}". 

IMPORTANT FORMATTING REQUIREMENTS:
- Write exactly 6-8 complete, well-structured sentences
- Use proper punctuation: periods, commas, semicolons, and colons as appropriate
- Ensure each sentence ends with a period
- Use proper capitalization and grammar
- Write in a professional, journalistic style

CONTENT REQUIREMENTS:
- Capture the main topics and key findings comprehensively
- Include specific examples, important terms, and likely key search terms
- Mention product types (e.g., water bottles, food packaging) if relevant
- Include relevant category mentions (e.g., health impacts, environmental sources)
- Provide enough detail to significantly improve searchability for specific keywords and concepts

Respond with only the summary text, properly punctuated and formatted.`;
    
    const startTime = Date.now();
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", 
            messages: [{ role: "user", content: prompt }], 
            max_tokens: 250,
            temperature: 0.5, 
            n: 1,
        });
        
        const duration = Date.now() - startTime;
        let result = completion.choices[0]?.message?.content?.trim() || null;
        
        // Post-process to ensure proper punctuation and decode HTML entities
        if (result) {
            // Decode HTML entities (like &#x27; for apostrophe)
            result = result
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
            
            // Ensure the summary ends with a period
            if (!result.endsWith('.') && !result.endsWith('!') && !result.endsWith('?')) {
                result += '.';
            }
            
            // Clean up any double periods
            result = result.replace(/\.\.+/g, '.');
            
            // Ensure proper spacing after periods
            result = result.replace(/\.([A-Z])/g, '. $1');
        }
        
        // Log usage
        await logTextGenerationUsage(
            'openai',
            'gpt-3.5-turbo',
            'summary',
            completion.usage,
            duration,
            true,
            null,
            process.env.OPENAI_API_KEY?.slice(-8) // Last 8 chars of API key for identification
        );
        
        return result;
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error('Error generating summary with OpenAI:', error.response ? `${error.message} - ${JSON.stringify(error.response.data)}` : error.message);
        
        // Log failed usage
        await logTextGenerationUsage(
            'openai',
            'gpt-3.5-turbo',
            'summary',
            { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            duration,
            false,
            error,
            process.env.OPENAI_API_KEY?.slice(-8)
        );
        
        return null;
    }
}

// Function to sanitize titles for image generation to avoid safety system triggers
function sanitizeTitleForImageGeneration(title) {
    if (!title) return 'scientific research';
    
    // Remove potentially problematic words/phrases
    const problematicTerms = [
        'death', 'die', 'dying', 'killed', 'killing', 'murder', 'suicide',
        'cancer', 'disease', 'illness', 'sick', 'toxic', 'poison', 'harmful',
        'dangerous', 'risk', 'threat', 'crisis', 'emergency', 'disaster',
        'contamination', 'pollution', 'waste', 'trash', 'garbage',
        'plastic', 'microplastic', 'nanoplastic', 'particle', 'fragment'
    ];
    
    let sanitized = title.toLowerCase();
    
    // Replace problematic terms with safer alternatives
    problematicTerms.forEach(term => {
        const regex = new RegExp(`\\b${term}\\b`, 'gi');
        sanitized = sanitized.replace(regex, 'environmental health');
    });
    
    // Remove special characters and numbers
    sanitized = sanitized.replace(/[^\w\s]/g, ' ');
    
    // Clean up multiple spaces
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    
    // If title becomes too short or empty, use generic term
    if (sanitized.length < 10) {
        sanitized = 'scientific research environmental health';
    }
    
    return sanitized.substring(0, 100); // Limit length
}

function determineCulturalContext(title, articleUrl) {
    const titleLower = title.toLowerCase();
    const urlLower = articleUrl.toLowerCase();
    
    // Check for Japanese context
    if (titleLower.includes('japan') || titleLower.includes('japanese') || 
        titleLower.includes('tokyo') || titleLower.includes('mitsubishi') ||
        urlLower.includes('.jp') || urlLower.includes('japan')) {
        return {
            context: 'Japanese',
            instruction: 'For Japanese articles: Include Japanese people in professional settings, wearing appropriate business attire or lab coats'
        };
    }
    
    // Check for European context
    if (titleLower.includes('europe') || titleLower.includes('european') ||
        titleLower.includes('germany') || titleLower.includes('france') ||
        titleLower.includes('uk') || titleLower.includes('britain') ||
        titleLower.includes('italy') || titleLower.includes('spain') ||
        urlLower.includes('.eu') || urlLower.includes('.de') || 
        urlLower.includes('.fr') || urlLower.includes('.uk')) {
        return {
            context: 'European',
            instruction: 'For European articles: Include European people in professional settings, wearing appropriate business attire or lab coats'
        };
    }
    
    // Check for American context
    if (titleLower.includes('usa') || titleLower.includes('united states') ||
        titleLower.includes('america') || titleLower.includes('american') ||
        titleLower.includes('california') || titleLower.includes('new york') ||
        urlLower.includes('.us') || urlLower.includes('usa')) {
        return {
            context: 'American',
            instruction: 'For American articles: Include American people in professional settings, wearing appropriate business attire or lab coats'
        };
    }
    
    // Check for Asian context (excluding Japan)
    if (titleLower.includes('china') || titleLower.includes('chinese') ||
        titleLower.includes('korea') || titleLower.includes('korean') ||
        titleLower.includes('india') || titleLower.includes('indian') ||
        titleLower.includes('singapore') || titleLower.includes('thailand') ||
        urlLower.includes('.cn') || urlLower.includes('.kr') || 
        urlLower.includes('.in') || urlLower.includes('.sg')) {
        return {
            context: 'Asian',
            instruction: 'For Asian articles: Include Asian people in professional settings, wearing appropriate business attire or lab coats'
        };
    }
    
    // Default to diverse representation
    return {
        context: 'Global',
        instruction: 'For global/international articles: Include diverse, multicultural representation with people from various ethnic backgrounds in professional settings'
    };
}

async function generateAndStoreImage(title, articleUrl) {
    if (!openai || !process.env.BLOB_READ_WRITE_TOKEN || !title || !articleUrl) {
        console.error("generateAndStoreImage: Pre-requisites not met (OpenAI, Blob Token, title, or URL).");
        return null;
    }
    
    // Sanitize the title to avoid safety system triggers
    const sanitizedTitle = sanitizeTitleForImageGeneration(title);
    
    // Determine cultural context from title and URL
    const culturalContext = determineCulturalContext(title, articleUrl);
    
    const new_prompt = `Create a professional editorial photograph for a scientific research article about environmental health and sustainability. 

CRITICAL REQUIREMENTS:
- NO TEXT, WORDS, LETTERS, NUMBERS, OR WRITING OF ANY KIND
- NO SIGNS, LABELS, HEADLINES, OR CAPTIONS
- NO WATERMARKS, LOGOS, OR BRANDING
- Focus on visual elements only: objects, environments, people, nature

VISUAL STYLE:
- Realistic editorial photography style
- Natural lighting and professional composition
- Clean, uncluttered backgrounds
- Focus on symbolic objects or environmental scenes related to scientific research

CULTURAL AWARENESS:
- Consider the article's geographic/cultural context when including people
- ${culturalContext.instruction}
- Avoid cultural stereotypes or inappropriate representations

PEOPLE (if included):
- Neutral expressions, not smiling
- Professional appearance appropriate to the cultural context
- Subtle concern or serious demeanor
- Avoid dramatic or distressed expressions
- Dress appropriately for the cultural setting (business attire, lab coats, etc.)

The image should communicate scientific research themes through visual symbolism only, without any textual elements whatsoever.`;
    
    const startTime = Date.now();
    try {
        const imageResponse = await openai.images.generate({
            model: "dall-e-3", prompt: new_prompt, n: 1, size: "1024x1024", response_format: "url", quality: "standard", style: "natural"
        });
        
        const duration = Date.now() - startTime;
        const tempImageUrl = imageResponse.data?.[0]?.url;
        if (!tempImageUrl) {
            // Log failed usage
            await logImageGenerationUsage(
                'openai',
                'dall-e-3',
                'image_generation',
                'standard',
                duration,
                false,
                new Error('No image URL returned'),
                process.env.OPENAI_API_KEY?.slice(-8)
            );
            return null;
        }
        
        const imageBufferResponse = await axios.get(tempImageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = imageBufferResponse.data;
        if (!imageBuffer) {
            // Log failed usage
            await logImageGenerationUsage(
                'openai',
                'dall-e-3',
                'image_generation',
                'standard',
                duration,
                false,
                new Error('Failed to download image'),
                process.env.OPENAI_API_KEY?.slice(-8)
            );
            return null;
        }
        
        const sanitizedUrlPart = articleUrl.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
        const filename = `article-images/${sanitizedUrlPart}-${Date.now()}.png`;
        const blob = await put(filename, imageBuffer, { access: 'public', contentType: 'image/png', addRandomSuffix: false, token: process.env.BLOB_READ_WRITE_TOKEN });
        
        // Log successful usage
        await logImageGenerationUsage(
            'openai',
            'dall-e-3',
            'image_generation',
            'standard',
            duration,
            true,
            null,
            process.env.OPENAI_API_KEY?.slice(-8)
        );
        
        return blob.url;
    } catch (error) {
        const duration = Date.now() - startTime;
        
        // Check if it's a safety system rejection
        if (error.message && error.message.includes('safety system')) {
            console.warn(`Image generation blocked by safety system for title: "${title.substring(0, 50)}..."`);
            console.warn('This is likely due to sensitive content in the article title.');
            
            // Log failed usage with specific safety system flag
            await logImageGenerationUsage(
                'openai',
                'dall-e-3',
                'image_generation',
                'standard',
                duration,
                false,
                new Error('Safety system rejection'),
                process.env.OPENAI_API_KEY?.slice(-8)
            );
        } else {
            console.error('Error in generateAndStoreImage:', error.message);
            
            // Log failed usage
            await logImageGenerationUsage(
                'openai',
                'dall-e-3',
                'image_generation',
                'standard',
                duration,
                false,
                error,
                process.env.OPENAI_API_KEY?.slice(-8)
            );
        }
        
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
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.9, // Increased creativity to avoid duplicate content
      n: 1,
    });
    return response.choices[0].message.content.trim().replace(/^"|"$/g, '');
  } catch (error) {
    console.error('Error generating tweet text with OpenAI:', error);
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
      model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], max_tokens: 20, temperature: 0.8, n: 1,
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

  const hashtags = await generateHashtags(story.ai_summary);
  const storyUrl = `https://www.microplasticswatch.com/story/${story.id}`;
  
  const TWEET_LIMIT = 280;
  const TCO_URL_LENGTH = 23;

  const fixedPartsLength = TCO_URL_LENGTH + hashtags.length + 2;
  const maxTextLength = TWEET_LIMIT - fixedPartsLength;

  const tweetText = await generateTweetTextFromSummary(story.ai_summary, maxTextLength);
  
  return `${tweetText} ${hashtags} ${storyUrl}`;
}

async function processQueryAndSave(query) {
    if (!supabase) return { status: 'db_error', count: 0 };
    console.log(`[processQueryAndSave] Starting query: "${query}"`);

    const googleResponse = await fetchArticlesFromGoogle(query, 10);
    if (!googleResponse.success) {
        if (googleResponse.error?.status === 429) return { status: 'quota_error', count: 0 };
        if (googleResponse.error?.status === 'TIMEOUT') return { status: 'google_timeout_error', count: 0 };
        return { status: 'google_api_error', count: 0 };
    }

    const articles = googleResponse.articles;
    if (!articles || articles.length === 0) {
        console.log(`[LOG] Google returned 0 results for query: "${query}"`);
        return { status: 'success', count: 0 };
    }
    console.log(`[processQueryAndSave] Google returned ${articles.length} results for query.`);

    // Fetch ALL existing URLs using pagination (Supabase has 1000 row hard limit)
    console.log('[processQueryAndSave] Fetching all existing URLs with pagination...');
    let allExistingUrls = [];
    const pageSize = 1000;
    let page = 0;
    
    // Get total count first
    const { count, error: countError } = await supabase
        .from('latest_news')
        .select('*', { count: 'exact', head: true });
        
    if (countError) {
        console.error('[processQueryAndSave] DB error getting count:', countError.message);
        return { status: 'db_error', count: 0 };
    }
    
    // Fetch all URLs using pagination
    while (true) {
        const { data: pageData, error: urlFetchError } = await supabase
            .from('latest_news')
            .select('url')
            .range(page * pageSize, (page + 1) * pageSize - 1);
            
        if (urlFetchError) {
            console.error('[processQueryAndSave] DB error fetching existing URLs:', urlFetchError.message);
            return { status: 'db_error', count: 0 };
        }
        
        if (!pageData || pageData.length === 0) break;
        
        allExistingUrls.push(...pageData);
        
        if (pageData.length < pageSize) break; // Last page
        page++;
    }
    
    const existingUrls = new Set(allExistingUrls.map(item => item.url));
    console.log(`[processQueryAndSave] Found ${existingUrls.size} existing URLs in the database (total count: ${count}).`);

    let newArticlesAdded = 0;
    for (const article of articles) {
        const { title, link: googleUrl, snippet } = article;

        if (!googleUrl || !googleUrl.startsWith('http')) {
            console.warn(`[LOG] Skipping invalid URL from Google: ${googleUrl}`);
            continue;
        }

        if (existingUrls.has(googleUrl)) {
            console.log(`[LOG] Skipping (already exists by Google URL): ${googleUrl}`);
            continue; 
        }

        // Use the enhanced URL resolver
        const finalUrl = await resolveGoogleShareUrl(googleUrl);
        
        if (finalUrl !== googleUrl) {
            console.log(`[LOG] Resolved URL: ${googleUrl} -> ${finalUrl}`);
        }

        if (existingUrls.has(finalUrl)) {
            console.log(`[LOG] Skipping (already exists by final URL): ${finalUrl}`);
            continue;
        }

        console.log(`[LOG] PROCESSING NEW ARTICLE: "${title}" (${finalUrl})`);

        try {
            console.log(`[LOG] Generating AI summary for: ${title}`);
            const summary = await summarizeText(title, snippet);
            
            console.log(`[LOG] Generating AI image for: ${title}`);
            const imageUrl = await generateAndStoreImage(title, finalUrl);
            
            const sourceHostname = new URL(finalUrl).hostname;

            const newItem = {
                url: finalUrl,
                title: title || 'Title not available',
                ai_summary: summary,
                ai_image_url: imageUrl,
                source: sourceHostname,
                processed_at: new Date().toISOString()
            };

            const { error: insertError } = await supabase.from('latest_news').insert(newItem);

            if (insertError) {
                if (insertError.code === '23505') {
                    console.warn(`[processQueryAndSave] URL already exists (race condition): ${finalUrl}`);
                } else {
                    throw insertError;
                }
            } else {
                console.log(`[LOG] Successfully ADDED to DB: ${finalUrl}`);
                newArticlesAdded++;
                // Only add the final URL to prevent race conditions
                existingUrls.add(finalUrl);
            }
        } catch (error) {
            console.error(`[LOG] Error processing article "${title}" (${finalUrl}):`, error.message);
        }
    }
    
    console.log(`[processQueryAndSave] Finished query "${query}". Added ${newArticlesAdded} new articles.`);
    return { status: 'success', count: newArticlesAdded };
}

module.exports = {
  supabase,
  openai,
  SEARCH_QUERIES,
  fetchArticlesFromGoogle,
  summarizeText,
  generateAndStoreImage,
  generateTweetTextFromSummary,
  generateHashtags,
  generateTweetPreview,
  processQueryAndSave,
  resolveGoogleShareUrl,
}; 