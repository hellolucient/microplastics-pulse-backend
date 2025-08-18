const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const axios = require('axios');
const { put } = require('@vercel/blob');
const he = require('he');

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

        let finalUrl = googleUrl;
        try {
            // For Google share URLs and other shortened URLs, try HEAD first, then limited GET
            if (googleUrl.includes('share.google') || googleUrl.includes('goo.gl') || googleUrl.includes('bit.ly') || googleUrl.includes('t.co')) {
                console.log(`[LOG] Detected shortened/share URL, resolving: ${googleUrl}`);
                try {
                    // Try HEAD request first (no content download)
                    const response = await axios.head(googleUrl, { timeout: 8000, maxRedirects: 5 });
                    // Get the final redirected URL
                    finalUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || googleUrl;
                } catch (headError) {
                    console.log(`[LOG] HEAD failed, trying limited GET...`);
                    try {
                        // If HEAD fails, try limited GET
                        const response = await axios.get(googleUrl, { 
                            timeout: 8000, 
                            maxRedirects: 5
                        });
                        // Get the final redirected URL
                        finalUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || googleUrl;
                    } catch (getError) {
                        console.warn(`[LOG] GET also failed for ${googleUrl}. Using original URL. Error: ${getError.message}`);
                        // Keep using googleUrl as finalUrl
                    }
                }
            } else {
                try {
                    const response = await axios.head(googleUrl, { timeout: 8000, maxRedirects: 5 });
                    finalUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || googleUrl;
                } catch (regularHeadError) {
                    console.warn(`[LOG] HEAD request failed for regular URL ${googleUrl}. Using original URL. Error: ${regularHeadError.message}`);
                    // Keep using googleUrl as finalUrl
                }
            }
            
            if (finalUrl !== googleUrl) {
                console.log(`[LOG] Resolved URL: ${googleUrl} -> ${finalUrl}`);
            }
        } catch (headError) {
            console.warn(`[LOG] URL resolution failed for ${googleUrl}. Using original URL. Error: ${headError.message}`);
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
}; 