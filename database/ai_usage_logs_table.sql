-- AI Usage Logs Table
-- This table tracks all AI model usage for cost monitoring and analytics

CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL, -- e.g., 'openai', 'anthropic', 'google'
    model VARCHAR(100) NOT NULL, -- e.g., 'gpt-4', 'claude-3-sonnet'
    operation_type VARCHAR(50) NOT NULL, -- e.g., 'text_generation', 'image_generation', 'embedding'
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_usd DECIMAL(10, 6) DEFAULT 0.000000,
    request_duration_ms INTEGER DEFAULT 0,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    api_key_id VARCHAR(100), -- Optional: track which API key was used
    metadata JSONB, -- Optional: additional metadata about the request
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_provider ON ai_usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model ON ai_usage_logs(model);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_operation_type ON ai_usage_logs(operation_type);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_success ON ai_usage_logs(success);

-- Add comments for documentation
COMMENT ON TABLE ai_usage_logs IS 'Tracks AI model usage for cost monitoring and analytics';
COMMENT ON COLUMN ai_usage_logs.provider IS 'AI service provider (openai, anthropic, google, etc.)';
COMMENT ON COLUMN ai_usage_logs.model IS 'Specific AI model used (gpt-4, claude-3-sonnet, etc.)';
COMMENT ON COLUMN ai_usage_logs.operation_type IS 'Type of AI operation (text_generation, image_generation, embedding, etc.)';
COMMENT ON COLUMN ai_usage_logs.cost_usd IS 'Cost in USD with 6 decimal precision';
COMMENT ON COLUMN ai_usage_logs.request_duration_ms IS 'Request duration in milliseconds';
COMMENT ON COLUMN ai_usage_logs.metadata IS 'Additional request metadata as JSON';
