const express = require('express');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { logTextGenerationUsage } = require('../../lib/aiUsageLogger');

const router = express.Router();

// Initialize AI clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Chat endpoint
router.post('/', async (req, res) => {
  try {
    const { message, chatMode, model, provider, conversationHistory = [] } = req.body;

    if (!message || !chatMode || !model || !provider) {
      return res.status(400).json({ 
        error: 'Missing required fields: message, chatMode, model, provider' 
      });
    }

    let response;
    
    if (chatMode === 'microplastics-research') {
      response = await generateResearchResponse(message, model, provider, conversationHistory);
    } else {
      response = await generateGeneralResponse(message, model, provider, conversationHistory);
    }

    res.json({ 
      reply: response,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chat API Error:', error);
    res.status(500).json({ 
      error: 'Failed to generate response',
      details: error.message 
    });
  }
});

// Generate embeddings endpoint with Server-Sent Events for progress
router.post('/generate-embeddings', async (req, res) => {
  try {
    console.log('🚀 Starting embedding generation via API...');
    
    // Set up Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: 'start', message: 'Starting embedding generation...' })}\n\n`);
    
    // Get articles without embeddings
    const { data: articles, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, title, ai_summary')
      .is('embedding', null)
      .not('ai_summary', 'is', null);

    if (fetchError) {
      console.error('Error fetching articles:', fetchError);
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to fetch articles' })}\n\n`);
      res.end();
      return;
    }

    if (!articles || articles.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'complete', message: 'All articles already have embeddings!', processed: 0, total: 0 })}\n\n`);
      res.end();
      return;
    }

    let processed = 0;
    let errors = 0;
    const total = articles.length;

    // Send total count
    res.write(`data: ${JSON.stringify({ type: 'total', total: total })}\n\n`);

    // Process articles in batches to avoid timeout
    const batchSize = 10;
    const batches = [];
    for (let i = 0; i < articles.length; i += batchSize) {
      batches.push(articles.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      for (const article of batch) {
        try {
          const textToEmbed = `${article.title}\n\n${article.ai_summary}`;
          const embedding = await generateEmbedding(textToEmbed);
          
          if (embedding) {
            const { error: updateError } = await supabase
              .from('latest_news')
              .update({ embedding: embedding })
              .eq('id', article.id);

            if (updateError) {
              console.error(`Error updating article ${article.id}:`, updateError);
              errors++;
            } else {
              processed++;
            }
          } else {
            errors++;
          }

          // Send progress update every 10 articles
          if (processed % 10 === 0 || processed === total) {
            const progress = Math.round((processed / total) * 100);
            console.log(`📈 Progress: ${processed}/${total} (${progress}%)`);
            res.write(`data: ${JSON.stringify({ type: 'progress', processed: processed, total: total, progress: progress })}\n\n`);
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));

        } catch (error) {
          console.error(`Error processing article ${article.id}:`, error.message);
          console.error(`Article title: ${article.title}`);
          console.error(`Article summary length: ${article.ai_summary?.length || 0}`);
          errors++;
        }
      }
    }

    // Send completion
    res.write(`data: ${JSON.stringify({ type: 'complete', message: 'Embedding generation complete!', processed: processed, errors: errors, total: total })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Embedding generation API error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to generate embeddings' })}\n\n`);
    res.end();
  }
});

// General chat response
async function generateGeneralResponse(message, model, provider, conversationHistory) {
  const systemPrompt = "You are a helpful AI assistant. Provide clear, accurate, and helpful responses.";
  const startTime = Date.now();
  
  if (provider === 'openai') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10), // Last 10 messages for context
      { role: 'user', content: message }
    ];

    try {
      const completion = await openai.chat.completions.create({
        model: model,
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7
      });

      const duration = Date.now() - startTime;
      
      // Log usage
      await logTextGenerationUsage(
        'openai',
        model,
        'chat_general',
        completion.usage,
        duration,
        true,
        null,
        process.env.OPENAI_API_KEY?.slice(-8)
      );

      return completion.choices[0].message.content;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log failed usage
      await logTextGenerationUsage(
        'openai',
        model,
        'chat_general',
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        duration,
        false,
        error,
        process.env.OPENAI_API_KEY?.slice(-8)
      );
      
      throw error;
    }
  } 
  else if (provider === 'anthropic') {
    const messages = conversationHistory.slice(-10).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    try {
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'user', content: message }
        ]
      });

      const duration = Date.now() - startTime;
      
      // Log usage for Anthropic (they don't provide usage in response, so we estimate)
      const estimatedTokens = Math.ceil((message.length + response.content[0].text.length) / 4);
      await logTextGenerationUsage(
        'anthropic',
        model,
        'chat_general',
        { prompt_tokens: Math.ceil(message.length / 4), completion_tokens: Math.ceil(response.content[0].text.length / 4), total_tokens: estimatedTokens },
        duration,
        true,
        null,
        process.env.ANTHROPIC_API_KEY?.slice(-8)
      );

      return response.content[0].text;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log failed usage
      await logTextGenerationUsage(
        'anthropic',
        model,
        'chat_general',
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        duration,
        false,
        error,
        process.env.ANTHROPIC_API_KEY?.slice(-8)
      );
      
      throw error;
    }
  }
}

// Research chat with RAG
async function generateResearchResponse(message, model, provider, conversationHistory) {
  // Get relevant articles
  const relevantArticles = await getRelevantArticles(message);
  
  // Build context from articles
  const context = relevantArticles.map(article => 
    `Title: ${article.title}\nSummary: ${article.ai_summary}\nSource: ${article.url}\nDate: ${article.published_date}`
  ).join('\n\n---\n\n');

  const systemPrompt = `You are a microplastics research assistant. Based on the following research articles from the Microplastics Pulse database, answer the user's question. If the articles don't contain enough information to fully answer the question, say so and suggest what additional research might be needed.

Research Articles:
${context}

Please provide a comprehensive answer based on the research, and cite specific articles when relevant. Include the source URLs for transparency.`;

  const startTime = Date.now();

  if (provider === 'openai') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10),
      { role: 'user', content: message }
    ];

    try {
      const completion = await openai.chat.completions.create({
        model: model,
        messages: messages,
        max_tokens: 1500,
        temperature: 0.7
      });

      const duration = Date.now() - startTime;
      
      // Log usage
      await logTextGenerationUsage(
        'openai',
        model,
        'chat_research',
        completion.usage,
        duration,
        true,
        null,
        process.env.OPENAI_API_KEY?.slice(-8)
      );

      return completion.choices[0].message.content;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log failed usage
      await logTextGenerationUsage(
        'openai',
        model,
        'chat_research',
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        duration,
        false,
        error,
        process.env.OPENAI_API_KEY?.slice(-8)
      );
      
      throw error;
    }
  } 
  else if (provider === 'anthropic') {
    const messages = conversationHistory.slice(-10).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    try {
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'user', content: message }
        ]
      });

      const duration = Date.now() - startTime;
      
      // Log usage for Anthropic (they don't provide usage in response, so we estimate)
      const estimatedTokens = Math.ceil((message.length + response.content[0].text.length) / 4);
      await logTextGenerationUsage(
        'anthropic',
        model,
        'chat_research',
        { prompt_tokens: Math.ceil(message.length / 4), completion_tokens: Math.ceil(response.content[0].text.length / 4), total_tokens: estimatedTokens },
        duration,
        true,
        null,
        process.env.ANTHROPIC_API_KEY?.slice(-8)
      );

      return response.content[0].text;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log failed usage
      await logTextGenerationUsage(
        'anthropic',
        model,
        'chat_research',
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        duration,
        false,
        error,
        process.env.ANTHROPIC_API_KEY?.slice(-8)
      );
      
      throw error;
    }
  }
}

// Generate embedding for text using OpenAI
async function generateEmbedding(text) {
  try {
    if (!text || text.trim().length === 0) {
      console.error('Empty text provided for embedding');
      return null;
    }

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error.message);
    if (error.status === 429) {
      console.error('Rate limit exceeded - waiting before retry');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return null;
  }
}

// Calculate cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Get relevant articles for RAG with enhanced semantic search
async function getRelevantArticles(query) {
  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);
    
    if (!queryEmbedding) {
      // Fallback to simple text search if embedding fails
      return await getRelevantArticlesFallback(query);
    }

    // Get all articles with embeddings
    const { data: articles, error } = await supabase
      .from('latest_news')
      .select('id, title, ai_summary, url, published_date, embedding')
      .not('embedding', 'is', null)
      .not('ai_summary', 'is', null);

    if (error) {
      console.error('Error fetching articles with embeddings:', error);
      return await getRelevantArticlesFallback(query);
    }

    if (!articles || articles.length === 0) {
      return await getRelevantArticlesFallback(query);
    }

    // Calculate similarity scores
    const articlesWithSimilarity = articles.map(article => {
      const similarity = cosineSimilarity(queryEmbedding, article.embedding);
      return {
        ...article,
        similarity
      };
    });

    // Sort by similarity and get top 5
    const relevantArticles = articlesWithSimilarity
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .filter(article => article.similarity > 0.7) // Only include articles with good similarity
      .map(({ similarity, embedding, ...article }) => article); // Remove similarity and embedding from response

    // If we have good semantic matches, return them
    if (relevantArticles.length > 0) {
      return relevantArticles;
    }

    // Otherwise, fallback to text search
    return await getRelevantArticlesFallback(query);

  } catch (error) {
    console.error('Error in enhanced article retrieval:', error);
    return await getRelevantArticlesFallback(query);
  }
}

// Fallback to simple text-based search
async function getRelevantArticlesFallback(query) {
  try {
    const searchTerms = query.toLowerCase().split(' ').filter(term => term.length > 2);
    
    if (searchTerms.length === 0) {
      // If no meaningful search terms, return recent articles
      const { data } = await supabase
        .from('latest_news')
        .select('title, ai_summary, url, published_date')
        .order('published_date', { ascending: false })
        .limit(5);
      
      return data || [];
    }

    // Build search query
    const searchQuery = searchTerms.map(term => 
      `title.ilike.%${term}%, ai_summary.ilike.%${term}%`
    ).join(',');

    const { data } = await supabase
      .from('latest_news')
      .select('title, ai_summary, url, published_date')
      .or(searchQuery)
      .order('published_date', { ascending: false })
      .limit(5);

    // If no results, fallback to recent articles
    if (!data || data.length === 0) {
      const { data: fallbackData } = await supabase
        .from('latest_news')
        .select('title, ai_summary, url, published_date')
        .order('published_date', { ascending: false })
        .limit(3);
      
      return fallbackData || [];
    }

    return data;
  } catch (error) {
    console.error('Error in fallback article retrieval:', error);
    return [];
  }
}

module.exports = router;
