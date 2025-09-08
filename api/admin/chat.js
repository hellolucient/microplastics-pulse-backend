const express = require('express');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

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

// General chat response
async function generateGeneralResponse(message, model, provider, conversationHistory) {
  const systemPrompt = "You are a helpful AI assistant. Provide clear, accurate, and helpful responses.";
  
  if (provider === 'openai') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10), // Last 10 messages for context
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: model,
      messages: messages,
      max_tokens: 1000,
      temperature: 0.7
    });

    return completion.choices[0].message.content;
  } 
  else if (provider === 'anthropic') {
    const messages = conversationHistory.slice(-10).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        ...messages,
        { role: 'user', content: message }
      ]
    });

    return response.content[0].text;
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

  if (provider === 'openai') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10),
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: model,
      messages: messages,
      max_tokens: 1500,
      temperature: 0.7
    });

    return completion.choices[0].message.content;
  } 
  else if (provider === 'anthropic') {
    const messages = conversationHistory.slice(-10).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        ...messages,
        { role: 'user', content: message }
      ]
    });

    return response.content[0].text;
  }
}

// Get relevant articles for RAG
async function getRelevantArticles(query) {
  try {
    // Simple text-based search (can be enhanced with embeddings later)
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
    console.error('Error fetching relevant articles:', error);
    return [];
  }
}

module.exports = router;
