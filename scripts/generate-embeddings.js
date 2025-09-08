require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Generate embedding for text using OpenAI
async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

// Generate embeddings for articles that don't have them
async function generateEmbeddingsForArticles() {
  try {
    console.log('🚀 Starting embedding generation for articles...');
    
    // Get articles without embeddings
    const { data: articles, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, title, ai_summary')
      .is('embedding', null)
      .not('ai_summary', 'is', null);

    if (fetchError) {
      console.error('Error fetching articles:', fetchError);
      return;
    }

    if (!articles || articles.length === 0) {
      console.log('✅ All articles already have embeddings!');
      return;
    }

    console.log(`📊 Found ${articles.length} articles without embeddings`);

    let processed = 0;
    let errors = 0;

    for (const article of articles) {
      try {
        // Combine title and summary for embedding
        const textToEmbed = `${article.title}\n\n${article.ai_summary}`;
        
        console.log(`🔄 Processing article ${article.id}: "${article.title.substring(0, 50)}..."`);
        
        const embedding = await generateEmbedding(textToEmbed);
        
        if (embedding) {
          // Update the article with the embedding
          const { error: updateError } = await supabase
            .from('latest_news')
            .update({ embedding: embedding })
            .eq('id', article.id);

          if (updateError) {
            console.error(`❌ Error updating article ${article.id}:`, updateError);
            errors++;
          } else {
            console.log(`✅ Successfully generated embedding for article ${article.id}`);
            processed++;
          }
        } else {
          console.error(`❌ Failed to generate embedding for article ${article.id}`);
          errors++;
        }

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Error processing article ${article.id}:`, error);
        errors++;
      }
    }

    console.log(`\n🎉 Embedding generation complete!`);
    console.log(`✅ Successfully processed: ${processed} articles`);
    console.log(`❌ Errors: ${errors} articles`);
    console.log(`📊 Total articles: ${articles.length}`);

  } catch (error) {
    console.error('❌ Fatal error in embedding generation:', error);
  }
}

// Run the script
if (require.main === module) {
  generateEmbeddingsForArticles()
    .then(() => {
      console.log('🏁 Script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Script failed:', error);
      process.exit(1);
    });
}

module.exports = { generateEmbeddingsForArticles, generateEmbedding };
