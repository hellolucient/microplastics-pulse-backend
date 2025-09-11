require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function checkDocument() {
  console.log('=== CHECKING DOCUMENT STATUS ===');
  
  try {
    // Check all documents (including inactive ones)
    const { data: allDocuments, error: allError } = await supabase
      .from('rag_documents')
      .select('*')
      .order('created_at', { ascending: false });
      
    if (allError) {
      console.error('Error fetching all documents:', allError);
      return;
    }
    
    console.log(`Total documents in database: ${allDocuments.length}`);
    console.log('');
    
    allDocuments.forEach((doc, index) => {
      console.log(`Document ${index + 1}:`);
      console.log(`  ID: ${doc.id}`);
      console.log(`  Title: ${doc.title}`);
      console.log(`  File Type: ${doc.file_type}`);
      console.log(`  Access Level: ${doc.access_level}`);
      console.log(`  Is Active: ${doc.is_active}`);
      console.log(`  Has Embedding: ${doc.embedding ? 'YES' : 'NO'}`);
      console.log(`  Content Length: ${doc.content ? doc.content.length : 0}`);
      console.log(`  Created At: ${doc.created_at}`);
      console.log('');
    });
    
    // Check chunks for each document
    for (const doc of allDocuments) {
      const { data: chunks, error: chunksError } = await supabase
        .from('rag_document_chunks')
        .select('id, chunk_index, embedding')
        .eq('document_id', doc.id);
        
      if (chunksError) {
        console.error(`Error fetching chunks for ${doc.title}:`, chunksError);
        continue;
      }
      
      const chunksWithEmbeddings = chunks.filter(chunk => chunk.embedding).length;
      console.log(`Chunks for "${doc.title}":`);
      console.log(`  Total chunks: ${chunks.length}`);
      console.log(`  With embeddings: ${chunksWithEmbeddings}`);
      console.log(`  Without embeddings: ${chunks.length - chunksWithEmbeddings}`);
      console.log('');
    }
    
  } catch (error) {
    console.error('Error checking document:', error);
  }
}

checkDocument().catch(console.error);
