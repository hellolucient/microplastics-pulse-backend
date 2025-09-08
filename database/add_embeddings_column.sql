-- Add embedding column to latest_news table for RAG functionality
-- This column will store OpenAI embeddings as JSON arrays

ALTER TABLE latest_news 
ADD COLUMN IF NOT EXISTS embedding JSONB;

-- Add index for better performance when querying embeddings
CREATE INDEX IF NOT EXISTS idx_latest_news_embedding 
ON latest_news USING GIN (embedding);

-- Add comment to document the column purpose
COMMENT ON COLUMN latest_news.embedding IS 'OpenAI text-embedding-3-small embeddings for semantic search in RAG system';
