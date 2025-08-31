-- Create subscribers table for email collection
CREATE TABLE IF NOT EXISTS subscribers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    source VARCHAR(100) DEFAULT 'whitepaper_download',
    first_download TIMESTAMP WITH TIME ZONE NOT NULL,
    last_download TIMESTAMP WITH TIME ZONE NOT NULL,
    download_count INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on email for fast lookups
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);

-- Create index on source for analytics
CREATE INDEX IF NOT EXISTS idx_subscribers_source ON subscribers(source);

-- Create index on created_at for date-based queries
CREATE INDEX IF NOT EXISTS idx_subscribers_created_at ON subscribers(created_at);

-- Create function to increment download count
CREATE OR REPLACE FUNCTION increment_download_count(subscriber_id UUID)
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT download_count + 1 
        FROM subscribers 
        WHERE id = subscriber_id
    );
END;
$$ LANGUAGE plpgsql;

-- Add RLS (Row Level Security) policies if needed
-- ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;

-- Grant necessary permissions (adjust based on your Supabase setup)
-- GRANT ALL ON subscribers TO authenticated;
-- GRANT ALL ON subscribers TO service_role;

-- Insert a sample record for testing (optional)
-- INSERT INTO subscribers (email, source, first_download, last_download) 
-- VALUES ('test@example.com', 'whitepaper_download', NOW(), NOW())
-- ON CONFLICT (email) DO NOTHING;
