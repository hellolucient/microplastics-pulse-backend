// This file will contain the master logic for running all scheduled, automated tasks.
const { createClient } = require('@supabase/supabase-js');
const { processQueryAndSave, SEARCH_QUERIES } = require('./coreLogic');
const { main: processEmails } = require('../scripts/gmail-processor/index');
const { postTweetForNextCandidate } = require('./twitterService');

async function logToSupabase(logData) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('automation_logs').insert([logData]);
  if (error) {
    console.error('[Automation] !!! FAILED TO WRITE LOG TO SUPABASE !!!', error);
  }
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