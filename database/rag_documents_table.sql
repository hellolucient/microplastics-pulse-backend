-- RAG Documents Table
-- This table stores uploaded documents for RAG (Retrieval-Augmented Generation) functionality

CREATE TABLE IF NOT EXISTS rag_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    file_type VARCHAR(50), -- 'pdf', 'docx', 'txt', 'url', 'manual'
    file_url TEXT, -- URL to stored file (if applicable)
    file_size INTEGER, -- File size in bytes
    embedding JSONB, -- OpenAI embeddings for semantic search
    metadata JSONB, -- Additional document metadata (author, date, etc.)
    access_level VARCHAR(20) DEFAULT 'admin' CHECK (access_level IN ('public', 'admin', 'restricted')),
    uploaded_by VARCHAR(255), -- Admin email who uploaded
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_rag_documents_access_level ON rag_documents(access_level);
CREATE INDEX IF NOT EXISTS idx_rag_documents_file_type ON rag_documents(file_type);
CREATE INDEX IF NOT EXISTS idx_rag_documents_uploaded_by ON rag_documents(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_rag_documents_created_at ON rag_documents(created_at);
CREATE INDEX IF NOT EXISTS idx_rag_documents_is_active ON rag_documents(is_active);

-- Index for embeddings (semantic search)
CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding ON rag_documents USING GIN (embedding);

-- Add comments for documentation
COMMENT ON TABLE rag_documents IS 'Stores uploaded documents for RAG functionality with access control';
COMMENT ON COLUMN rag_documents.title IS 'Document title for display and search';
COMMENT ON COLUMN rag_documents.content IS 'Extracted text content from the document';
COMMENT ON COLUMN rag_documents.file_type IS 'Type of document (pdf, docx, txt, url, manual)';
COMMENT ON COLUMN rag_documents.file_url IS 'URL to stored file in cloud storage (if applicable)';
COMMENT ON COLUMN rag_documents.file_size IS 'File size in bytes';
COMMENT ON COLUMN rag_documents.embedding IS 'OpenAI text-embedding-3-small embeddings for semantic search';
COMMENT ON COLUMN rag_documents.metadata IS 'Additional document metadata as JSON (author, date, source, etc.)';
COMMENT ON COLUMN rag_documents.access_level IS 'Access control: public (visible to all), admin (admin only), restricted (specific access)';
COMMENT ON COLUMN rag_documents.uploaded_by IS 'Email of admin who uploaded the document';
COMMENT ON COLUMN rag_documents.is_active IS 'Whether the document is active and should be included in searches';

-- Create function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_rag_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_rag_documents_updated_at
    BEFORE UPDATE ON rag_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_rag_documents_updated_at();

-- Insert sample documents for testing (optional)
-- INSERT INTO rag_documents (title, content, file_type, access_level, uploaded_by, metadata) 
-- VALUES 
--     ('Microplastics Whitepaper', 'This is a comprehensive whitepaper about microplastics research...', 'pdf', 'public', 'admin@example.com', '{"author": "Research Team", "date": "2024-01-01", "pages": 25}'),
--     ('Internal Research Notes', 'Confidential research findings about microplastics...', 'docx', 'admin', 'admin@example.com', '{"author": "Internal Team", "date": "2024-01-15", "confidential": true}');
