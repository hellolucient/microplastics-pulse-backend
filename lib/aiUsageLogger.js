const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Pricing per 1M tokens (as of 2024)
const PRICING = {
  openai: {
    'gpt-3.5-turbo': {
      input: 0.50,   // $0.50 per 1M input tokens
      output: 1.50   // $1.50 per 1M output tokens
    },
    'gpt-4': {
      input: 30.00,  // $30.00 per 1M input tokens
      output: 60.00  // $60.00 per 1M output tokens
    },
    'gpt-4-turbo': {
      input: 10.00,  // $10.00 per 1M input tokens
      output: 30.00  // $30.00 per 1M output tokens
    },
    'dall-e-3': {
      standard: 0.040,  // $0.040 per image (1024x1024)
      hd: 0.080         // $0.080 per image (1024x1024 HD)
    }
  },
  anthropic: {
    'claude-3-sonnet': {
      input: 3.00,   // $3.00 per 1M input tokens
      output: 15.00  // $15.00 per 1M output tokens
    },
    'claude-3-haiku': {
      input: 0.25,   // $0.25 per 1M input tokens
      output: 1.25   // $1.25 per 1M output tokens
    },
    'claude-3-opus': {
      input: 15.00,  // $15.00 per 1M input tokens
      output: 75.00  // $75.00 per 1M output tokens
    }
  }
};

/**
 * Calculate cost for text generation based on tokens and model
 */
function calculateTextCost(provider, model, inputTokens, outputTokens) {
  const providerPricing = PRICING[provider];
  if (!providerPricing || !providerPricing[model]) {
    console.warn(`Unknown pricing for ${provider}/${model}, using default`);
    return 0.001; // Default small cost
  }

  const modelPricing = providerPricing[model];
  const inputCost = (inputTokens / 1000000) * modelPricing.input;
  const outputCost = (outputTokens / 1000000) * modelPricing.output;
  
  return inputCost + outputCost;
}

/**
 * Calculate cost for image generation
 */
function calculateImageCost(provider, model, quality = 'standard') {
  if (provider === 'openai' && model === 'dall-e-3') {
    const pricing = PRICING.openai['dall-e-3'];
    return quality === 'hd' ? pricing.hd : pricing.standard;
  }
  
  // Default cost for unknown image models
  return 0.05;
}

/**
 * Log AI usage to the database
 */
async function logAIUsage({
  provider,
  model,
  operationType,
  inputTokens = 0,
  outputTokens = 0,
  totalTokens = 0,
  costUsd = 0,
  requestDurationMs = 0,
  success = true,
  errorMessage = null,
  apiKeyId = null,
  metadata = null
}) {
  try {
    const logData = {
      provider,
      model,
      operation_type: operationType,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens || (inputTokens + outputTokens),
      cost_usd: costUsd,
      request_duration_ms: requestDurationMs,
      success,
      error_message: errorMessage,
      api_key_id: apiKeyId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('ai_usage_logs')
      .insert(logData);

    if (error) {
      console.error('Error logging AI usage:', error);
    } else {
      console.log(`[AI Usage] Logged ${operationType} - ${provider}/${model} - $${costUsd.toFixed(6)}`);
    }
  } catch (error) {
    console.error('Error in logAIUsage:', error);
  }
}

/**
 * Wrapper function to log text generation usage
 */
async function logTextGenerationUsage(provider, model, operationType, usage, duration, success, error, apiKeyId = null) {
  const cost = calculateTextCost(provider, model, usage.prompt_tokens, usage.completion_tokens);
  
  await logAIUsage({
    provider,
    model,
    operationType,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costUsd: cost,
    requestDurationMs: duration,
    success,
    errorMessage: error?.message || null,
    apiKeyId
  });
}

/**
 * Wrapper function to log image generation usage
 */
async function logImageGenerationUsage(provider, model, operationType, quality, duration, success, error, apiKeyId = null) {
  const cost = calculateImageCost(provider, model, quality);
  
  await logAIUsage({
    provider,
    model,
    operationType,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: cost,
    requestDurationMs: duration,
    success,
    errorMessage: error?.message || null,
    apiKeyId
  });
}

module.exports = {
  logAIUsage,
  logTextGenerationUsage,
  logImageGenerationUsage,
  calculateTextCost,
  calculateImageCost,
  PRICING
};
