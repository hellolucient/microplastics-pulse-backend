-- RAG Document Chunks Table
-- This table stores individual chunks of documents with their embeddings for better semantic search

CREATE TABLE IF NOT EXISTS rag_document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding JSONB, -- OpenAI embeddings for semantic search
    word_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_document_id ON rag_document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_chunk_index ON rag_document_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_word_count ON rag_document_chunks(word_count);

-- Index for embeddings (semantic search)
CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_embedding ON rag_document_chunks USING GIN (embedding);

-- Add comments for documentation
COMMENT ON TABLE rag_document_chunks IS 'Stores individual chunks of documents with embeddings for semantic search';
COMMENT ON COLUMN rag_document_chunks.document_id IS 'Reference to the parent document';
COMMENT ON COLUMN rag_document_chunks.chunk_index IS 'Order of chunk within the document (0-based)';
COMMENT ON COLUMN rag_document_chunks.chunk_text IS 'Text content of this chunk';
COMMENT ON COLUMN rag_document_chunks.embedding IS 'OpenAI text-embedding-3-small embeddings for semantic search';
COMMENT ON COLUMN rag_document_chunks.word_count IS 'Number of words in this chunk';

-- Create function to update word count automatically
CREATE OR REPLACE FUNCTION update_chunk_word_count()
RETURNS TRIGGER AS $$
BEGIN
    NEW.word_count = array_length(string_to_array(trim(NEW.chunk_text), ' '), 1);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update word count
CREATE TRIGGER trigger_update_chunk_word_count
    BEFORE INSERT OR UPDATE ON rag_document_chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_chunk_word_count();
