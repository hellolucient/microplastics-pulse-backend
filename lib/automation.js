// This file will contain the master logic for running all scheduled, automated tasks.
const { createClient } = require('@supabase/supabase-js');
const { processQueryAndSave, SEARCH_QUERIES } = require('./coreLogic');
const { main: processEmails } = require('../scripts/gmail-processor/index');
const { postTweetForNextCandidate } = require('./twitterService');
const { OpenAI } = require('openai');

async function logToSupabase(logData) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('automation_logs').insert([logData]);
  if (error) {
    console.error('[Automation] !!! FAILED TO WRITE LOG TO SUPABASE !!!', error);
  }
}

// Initialize OpenAI client for embedding generation
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Generate embeddings for content that doesn't have them yet
async function generateMissingEmbeddings() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  let totalProcessed = 0;
  let totalErrors = 0;
  let articlesProcessed = 0;
  let documentsProcessed = 0;
  let chunksProcessed = 0;

  // Process articles without embeddings
  console.log('[Automation] Processing articles without embeddings...');
  const { data: articles, error: articlesError } = await supabase
    .from('latest_news')
    .select('id, title, ai_summary')
    .is('embedding', null)
    .not('ai_summary', 'is', null);

  if (articlesError) {
    console.error('Error fetching articles:', articlesError);
    throw new Error('Failed to fetch articles');
  }

  if (articles && articles.length > 0) {
    console.log(`[Automation] Found ${articles.length} articles to process`);
    
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
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
            totalErrors++;
          } else {
            articlesProcessed++;
            totalProcessed++;
          }
        } else {
          totalErrors++;
        }

        // Progress update every 10 articles
        if ((i + 1) % 10 === 0 || i === articles.length - 1) {
          const progress = Math.round(((i + 1) / articles.length) * 100);
          console.log(`[Automation] Articles progress: ${i + 1}/${articles.length} (${progress}%) - ${articlesProcessed} processed`);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`Error processing article ${article.id}:`, error.message);
        totalErrors++;
      }
    }
  } else {
    console.log('[Automation] No articles found without embeddings');
  }

  // Process RAG documents without embeddings
  console.log('[Automation] Processing RAG documents without embeddings...');
  const { data: documents, error: documentsError } = await supabase
    .from('rag_documents')
    .select('id, title, content')
    .is('embedding', null)
    .not('content', 'is', null)
    .eq('is_active', true);

  if (documentsError) {
    console.error('Error fetching documents:', documentsError);
    throw new Error('Failed to fetch documents');
  }

  if (documents && documents.length > 0) {
    console.log(`[Automation] Found ${documents.length} documents to process`);
    
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i];
      try {
        const textToEmbed = `${document.title}\n\n${document.content}`;
        const embedding = await generateEmbedding(textToEmbed);
        
        if (embedding) {
          const { error: updateError } = await supabase
            .from('rag_documents')
            .update({ embedding: embedding })
            .eq('id', document.id);

          if (updateError) {
            console.error(`Error updating document ${document.id}:`, updateError);
            totalErrors++;
          } else {
            documentsProcessed++;
            totalProcessed++;
          }
        } else {
          totalErrors++;
        }

        // Progress update for each document (since there are usually fewer documents)
        const progress = Math.round(((i + 1) / documents.length) * 100);
        console.log(`[Automation] Documents progress: ${i + 1}/${documents.length} (${progress}%) - ${documentsProcessed} processed`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`Error processing document ${document.id}:`, error);
        totalErrors++;
      }
    }
  } else {
    console.log('[Automation] No documents found without embeddings');
  }

  // Process RAG document chunks without embeddings
  console.log('[Automation] Processing document chunks without embeddings...');
  const { data: chunks, error: chunksError } = await supabase
    .from('rag_document_chunks')
    .select('id, document_id, chunk_index, chunk_text')
    .is('embedding', null)
    .not('chunk_text', 'is', null);
  
  if (chunksError) {
    console.error('Error fetching chunks:', chunksError);
    throw new Error('Failed to fetch chunks');
  }

  if (chunks && chunks.length > 0) {
    console.log(`[Automation] Found ${chunks.length} chunks to process`);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const embedding = await generateEmbedding(chunk.chunk_text);
        
        if (embedding) {
          const { error: updateError } = await supabase
            .from('rag_document_chunks')
            .update({ embedding: embedding })
            .eq('id', chunk.id);
          
          if (updateError) {
            console.error(`Error updating chunk ${chunk.id}:`, updateError);
            totalErrors++;
          } else {
            chunksProcessed++;
            totalProcessed++;
          }
        } else {
          totalErrors++;
        }
        
        // Progress update every 50 chunks (since there can be many chunks)
        if ((i + 1) % 50 === 0 || i === chunks.length - 1) {
          const progress = Math.round(((i + 1) / chunks.length) * 100);
          console.log(`[Automation] Chunks progress: ${i + 1}/${chunks.length} (${progress}%) - ${chunksProcessed} processed`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error processing chunk ${chunk.id}:`, error);
        totalErrors++;
      }
    }
  } else {
    console.log('[Automation] No chunks found without embeddings');
  }

  // Final summary
  console.log(`[Automation] Embedding generation complete!`);
  console.log(`[Automation] Articles: ${articlesProcessed} processed`);
  console.log(`[Automation] Documents: ${documentsProcessed} processed`);
  console.log(`[Automation] Chunks: ${chunksProcessed} processed`);
  console.log(`[Automation] Total: ${totalProcessed} embeddings generated (${totalErrors} errors)`);

  return {
    processed: totalProcessed,
    errors: totalErrors,
    articlesProcessed,
    documentsProcessed,
    chunksProcessed,
    message: `Generated ${totalProcessed} embeddings: ${articlesProcessed} articles, ${documentsProcessed} documents, ${chunksProcessed} chunks (${totalErrors} errors)`
  };
}

/**
 * Runs just the email check portion of the automation suite.
 * This is designed to be called by a manual trigger from the admin panel.
 */
async function runEmailCheck() {
  console.log('[Automation] Starting standalone Task: Checking for submitted emails...');
  try {
    const emailResult = await processEmails(); 
    // The front-end expects a specific format. Let's adapt the result.
    // The processor returns: { message, ..., failedUrls: [{url, reason}] }
    // The frontend expects: { message, ..., failedUrls: string[] }
    return {
      message: emailResult.message || 'Completed successfully.',
      processedCount: emailResult.processedCount || 0,
      failedCount: emailResult.failedCount || 0,
      failedUrls: emailResult.failedUrls || [], // Keep the full objects with reasons
      processedUrls: emailResult.processed || [] // Add successfully processed URLs
    };
  } catch (error) {
    console.error('[Automation] CRITICAL ERROR in standalone Email Check:', error);
    // Re-throw the error so the API endpoint can catch it and return a 500 status.
    throw error;
  }
}

/**
 * Runs the complete suite of scheduled tasks in sequence.
 */
async function runScheduledTasks() {
  console.log('[Automation] --- Starting Scheduled Task Suite ---');
  const report = {
    google_fetch: { status: 'PENDING', details: '', articles_added: 0 },
    email_check: { status: 'PENDING', details: '' },
    tweet_post: { status: 'PENDING', details: '' },
    embeddings: { status: 'PENDING', details: '', embeddings_generated: 0 },
  };

  // --- Task 1: Fetch News from Google ---
  try {
    console.log('[Automation] Starting Task 1: Fetching news from Google...');
    let totalAdded = 0;
    for (const query of SEARCH_QUERIES) {
      const result = await processQueryAndSave(query);
      if (result.status === 'success') {
        totalAdded += result.count;
      }
    }
    report.google_fetch = { status: 'SUCCESS', details: `Processed ${SEARCH_QUERIES.length} queries.`, articles_added: totalAdded };
    console.log(`[Automation] Finished Task 1. Total new articles from Google: ${totalAdded}.`);
  } catch (error) {
    console.error('[Automation] CRITICAL ERROR in Task 1 (Google Fetch):', error);
    report.google_fetch = { status: 'FAILURE', details: error.message, articles_added: 0 };
  }

  // --- Task 2: Check for Submitted Emails ---
  try {
    console.log('[Automation] Starting Task 2: Checking for submitted emails...');
    // The gmail-processor script returns a summary of its run
    const emailResult = await runEmailCheck(); 
    report.email_check = { status: 'SUCCESS', details: emailResult.message || 'Completed successfully.' };
    console.log('[Automation] Finished Task 2.');
  } catch (error) {
    console.error('[Automation] CRITICAL ERROR in Task 2 (Email Check):', error);
    report.email_check = { status: 'FAILURE', details: error.message };
  }

  // --- Task 3: Fetch & Post a Tweet ---
  try {
    console.log('[Automation] Starting Task 3: Posting next tweet...');
    const result = await postTweetForNextCandidate();
    report.tweet_post = { status: result.success ? 'SUCCESS' : 'SKIPPED', details: result.message };
    if (result.success) {
      console.log(`[Automation] Finished Task 3. Successfully posted tweet for story ID: ${result.storyId}`);
    } else {
      console.log(`[Automation] Finished Task 3. No tweet posted: ${result.message}`);
    }
  } catch (error) {
    console.error('[Automation] CRITICAL ERROR in Task 3 (Tweet Post):', error);
    report.tweet_post = { status: 'FAILURE', details: error.message };
  }

  // --- Task 4: Generate Missing Embeddings ---
  try {
    console.log('[Automation] Starting Task 4: Generating missing embeddings...');
    const result = await generateMissingEmbeddings();
    report.embeddings = { status: 'SUCCESS', details: result.message, embeddings_generated: result.processed };
    console.log(`[Automation] Finished Task 4. Generated ${result.processed} embeddings (${result.errors} errors).`);
  } catch (error) {
    console.error('[Automation] CRITICAL ERROR in Task 4 (Embeddings):', error);
    report.embeddings = { status: 'FAILURE', details: error.message, embeddings_generated: 0 };
  }

  const finalStatus = Object.values(report).some(task => task.status === 'FAILURE') ? 'FAILURE' : 'SUCCESS';
  
  await logToSupabase({
      status: finalStatus,
      details: report
  });

  console.log(`[Automation] --- Completed Scheduled Task Suite with final status: ${finalStatus} ---`);
  
  // Return the status and report for API consumers
  return {
    status: finalStatus,
    report: report
  };
}

module.exports = { runScheduledTasks, runEmailCheck }; 