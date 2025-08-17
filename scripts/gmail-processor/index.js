require('dotenv').config({ path: '../../.env' }); // Load .env from backend root
const Imap = require('imap');
const { simpleParser } = require('mailparser');
// const fs = require('fs').promises; // Removed fs
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js'); // Added Supabase

// const processedEmailsPath = path.join(__dirname, 'processed.json'); // Removed
const approvedSenders = ['hellolucient@gmail.com', 'trent.munday@gmail.com', 'gerrybodeker@gmail.com'];

// --- Initialize Supabase Client ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
let supabase;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('[GmailProcessor] Supabase client initialized.');
} else {
  console.error('[GmailProcessor] Error: SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env. GmailProcessor may not function correctly for duplicate checks.');
  // supabase will remain undefined, checks relying on it should fail gracefully or be skipped.
}
// --- End Supabase Client Initialization ---

// --- Supabase Helper Functions for Timestamp ---
const SCRIPT_METADATA_TABLE = 'script_metadata';
const LAST_CHECK_TIMESTAMP_KEY = 'last_email_check_timestamp';
const LAST_CHECK_UID_KEY = 'last_email_check_uid'; // New key for UID tracking

async function getLastCheckUid() {
    if (!supabase) {
        console.warn('[GmailProcessor] Supabase client not initialized. Cannot get last check UID.');
        return null;
    }
    try {
        const { data, error } = await supabase
            .from(SCRIPT_METADATA_TABLE)
            .select('value')
            .eq('key', LAST_CHECK_UID_KEY)
            .maybeSingle();

        if (error) {
            console.error('[GmailProcessor] Error fetching last check UID from Supabase:', error.message);
            return null;
        }
        if (data && data.value) {
            const uid = parseInt(data.value, 10);
            console.log(`[GmailProcessor] Retrieved last check UID: ${uid}`);
            return isNaN(uid) ? null : uid;
        }
        console.log('[GmailProcessor] No last check UID found in Supabase.');
        return null;
    } catch (e) {
        console.error('[GmailProcessor] Exception fetching last check UID:', e.message);
        return null;
    }
}

async function updateLastCheckUid(uid) {
    if (!supabase) {
        console.warn('[GmailProcessor] Supabase client not initialized. Cannot update last check UID.');
        return;
    }
    try {
        const { error } = await supabase
            .from(SCRIPT_METADATA_TABLE)
            .upsert({ key: LAST_CHECK_UID_KEY, value: uid.toString() }, { onConflict: 'key' });

        if (error) {
            console.error('[GmailProcessor] Error updating last check UID in Supabase:', error.message);
        } else {
            console.log(`[GmailProcessor] Successfully updated last check UID to: ${uid}`);
        }
    } catch (e) {
        console.error('[GmailProcessor] Exception updating last check UID:', e.message);
    }
}

async function getLastCheckTimestamp() {
    if (!supabase) {
        console.warn('[GmailProcessor] Supabase client not initialized. Cannot get last check timestamp.');
        return null;
    }
    try {
        const { data, error } = await supabase
            .from(SCRIPT_METADATA_TABLE)
            .select('value')
            .eq('key', LAST_CHECK_TIMESTAMP_KEY)
            .maybeSingle();

        if (error) {
            console.error('[GmailProcessor] Error fetching last check timestamp from Supabase:', error.message);
            return null;
        }
        if (data && data.value) {
            console.log(`[GmailProcessor] Retrieved last check timestamp: ${data.value}`);
            return new Date(data.value);
        }
        console.log('[GmailProcessor] No last check timestamp found in Supabase.');
        return null;
    } catch (e) {
        console.error('[GmailProcessor] Exception fetching last check timestamp:', e.message);
        return null;
    }
}

async function updateLastCheckTimestamp(timestamp) {
    if (!supabase) {
        console.warn('[GmailProcessor] Supabase client not initialized. Cannot update last check timestamp.');
        return;
    }
    try {
        // Add 1 second to the timestamp to ensure we don't re-fetch the exact same last email
        const nextTimestamp = new Date(timestamp.getTime() + 1000);
        const isoString = nextTimestamp.toISOString();

        const { error } = await supabase
            .from(SCRIPT_METADATA_TABLE)
            .upsert({ key: LAST_CHECK_TIMESTAMP_KEY, value: isoString }, { onConflict: 'key' });

        if (error) {
            console.error('[GmailProcessor] Error updating last check timestamp in Supabase:', error.message);
        } else {
            console.log(`[GmailProcessor] Successfully updated last check timestamp to: ${isoString}`);
        }
    } catch (e) {
        console.error('[GmailProcessor] Exception updating last check timestamp:', e.message);
    }
}
// --- End Supabase Helper Functions ---

// --- Core Logic Integration ---
// Import functions from coreLogic.js, assuming it's in lib/
const {
  supabase: coreSupabase,
  summarizeText,
  generateAndStoreImage,
} = require('../../lib/coreLogic');

// This function will handle the processing of a single URL from an email.
async function defaultUrlProcessor(url, subject) {
  if (!coreSupabase) {
    console.error('[UrlProcessor] Supabase client is not available. Aborting.');
    return { status: 'db_error', url };
  }
  console.log(`[UrlProcessor] Starting processing for URL: ${url}`);
  
  let finalUrl = url;
  try {
      // For Google share URLs and other shortened URLs, try HEAD first, then limited GET
  if (url.includes('share.google') || url.includes('goo.gl') || url.includes('bit.ly') || url.includes('t.co')) {
    console.log(`[UrlProcessor] Detected shortened/share URL, resolving: ${url}`);
    try {
      // Try HEAD request first (no content download)
      const response = await axios.head(url, { timeout: 15000, maxRedirects: 10 });
      // Get the final redirected URL
      finalUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || url;
    } catch (headError) {
      console.log(`[UrlProcessor] HEAD failed, trying limited GET...`);
      // If HEAD fails, try unlimited GET to follow redirects
      const response = await axios.get(url, { 
        timeout: 15000, 
        maxRedirects: 10
      });
      // Get the final redirected URL
      finalUrl = response.request.res.responseUrl || response.request._redirectable?._currentUrl || url;
    }
  } else {
    const response = await axios.head(url, { timeout: 15000, maxRedirects: 5 });
    finalUrl = response.request.res.responseUrl || url;
  }
    console.log(`[UrlProcessor] Resolved URL: ${url} -> ${finalUrl}`);
  } catch (headError) {
    console.warn(`[UrlProcessor] URL resolution failed for ${url}. Using original URL. Error: ${headError.message}`);
  }
  
  try {
    // Check if the URL already exists
    const { data: existing, error: checkError } = await coreSupabase
      .from('latest_news')
      .select('id')
      .eq('url', finalUrl)
      .maybeSingle();

    if (checkError) {
      console.error(`[UrlProcessor] Error checking for existing URL ${finalUrl}:`, checkError.message);
      return { status: 'db_error', url: finalUrl };
    }
    if (existing) {
      console.log(`[UrlProcessor] URL already exists. Skipping: ${finalUrl}`);
      return { status: 'skipped_duplicate', url: finalUrl };
    }

    // --- Process the new article ---
    console.log(`[UrlProcessor] PROCESSING NEW ARTICLE from email: "${subject}" (${finalUrl})`);
    
    // Use the email subject as the basis for the summary
    // We don't have a snippet, so we'll pass the subject as both.
    const summary = await summarizeText(subject, subject);
    if (!summary) {
        console.error('[UrlProcessor] Failed to generate summary. Aborting for this URL.');
        return { status: 'summary_failed', url: finalUrl };
    }

    const imageUrl = await generateAndStoreImage(subject, finalUrl);
     if (!imageUrl) {
        console.warn('[UrlProcessor] Failed to generate image. Proceeding without one.');
    }

    const sourceHostname = new URL(finalUrl).hostname;
    
    const newItem = {
      url: finalUrl,
      title: subject || 'Title not available',
      ai_summary: summary,
      ai_image_url: imageUrl,
      source: sourceHostname,
      processed_at: new Date().toISOString(),
      // submitted_by: 'email', // This column doesn't exist in the schema
    };

    const { error: insertError } = await coreSupabase.from('latest_news').insert(newItem);
    if (insertError) {
      console.error(`[UrlProcessor] Error inserting new article for ${finalUrl}:`, insertError.message);
      return { status: 'db_error', url: finalUrl };
    }
    
    console.log(`[UrlProcessor] Successfully ADDED to DB: ${finalUrl}`);
    return { status: 'success', url: finalUrl };

  } catch (error) {
    console.error(`[UrlProcessor] UNEXPECTED ERROR processing URL ${finalUrl}:`, error.message);
    return { status: 'processing_error', url: finalUrl };
  }
}
// --- End Core Logic Integration ---

const imapConfig = {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false } // Necessary for some environments, consider security implications
};

const GENERATION_ENDPOINT = process.env.GENERATION_ENDPOINT || 'https://yourapp.com/api/generate';

function connectToGmail() {
    return new Promise((resolve, reject) => {
        const imap = new Imap(imapConfig);

        imap.once('ready', () => {
            console.log('Connected to Gmail.');
            resolve(imap);
        });

        // Use 'on' to catch any errors that might occur after the initial connection
        imap.on('error', (err) => {
            console.error('IMAP connection error:', err);
            reject(err);
        });

        imap.once('end', () => {
            console.log('Disconnected from Gmail.');
        });

        imap.connect();
    });
}

async function searchEmails(imap) {
    return new Promise(async (resolve, reject) => {
        imap.openBox('INBOX', true, async (err, box) => {
            if (err) {
                console.error('Error opening INBOX:', err);
                reject(err);
                return;
            }
            console.log('INBOX opened.');

            // --- Build Filter Criteria ---
            let fromCriteria = [];
            if (approvedSenders.length > 0) {
                const criteria = approvedSenders.map(sender => ['FROM', sender]);
                if (criteria.length === 1) {
                    fromCriteria = criteria[0];
                } else {
                    // Build a nested OR structure e.g. ['OR', a, ['OR', b, c]]
                    let nestedOr = ['OR', criteria[criteria.length - 2], criteria[criteria.length - 1]];
                    for (let i = criteria.length - 3; i >= 0; i--) {
                        nestedOr = ['OR', criteria[i], nestedOr];
                    }
                    fromCriteria = nestedOr;
                }
            }
            // --- End Build Filter Criteria ---

            let searchCriteria;
            const lastUid = await getLastCheckUid();

            if (lastUid) {
                const nextUid = lastUid + 1;
                searchCriteria = [['UID', `${nextUid}:*`]];
                console.log(`[GmailProcessor] Using UID-based search. Searching for emails with UID > ${lastUid}`);
            } else {
                let sinceDate = await getLastCheckTimestamp(); // Fallback for first run
                if (!sinceDate) {
                    console.log('[GmailProcessor] No last UID or timestamp. Defaulting to search emails from the last 24 hours.');
                    sinceDate = new Date();
                    sinceDate.setDate(sinceDate.getDate() - 1);
                }
                searchCriteria = [['SINCE', sinceDate]];
                console.log(`[GmailProcessor] Using date-based search (fallback). Searching since: ${sinceDate.toISOString()}`);
            }

            // Add the sender filter to the search criteria
            if (fromCriteria.length > 0) {
                searchCriteria.push(fromCriteria);
            }
            console.log('[GmailProcessor] Searching with criteria:', JSON.stringify(searchCriteria));

            imap.search(searchCriteria, (searchErr, results) => {
                if (searchErr) {
                    console.error('Email search error:', searchErr);
                    reject({ emailsData: [], newestEmailUid: null, error: searchErr });
                    return;
                }
                
                console.log('[GmailProcessor] Raw search results:', results); // DEBUG LOGGING

                const newestEmailUid = results.length > 0 ? Math.max(lastUid || 0, ...results) : lastUid;
                console.log(`Found ${results.length} email(s) to process. Newest UID in batch will be ${newestEmailUid}.`);

                if (results.length === 0) {
                    resolve({ emailsData: [], newestEmailUid: lastUid });
                    return;
                }

                const f = imap.fetch(results, { bodies: '', markSeen: false }); // Fetch all results
                const emailsData = [];

                f.on('message', (msg, seqno) => {
                    console.log(`Fetching message #${seqno}`);
                    let buffer = '';
                    
                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('utf8');
                        });
                    });
                    // No longer need to get UID from attributes here
                    msg.once('end', () => {
                        emailsData.push({ buffer }); 
                    });
                });

                f.once('error', (fetchErr) => {
                    console.error('Fetch error:', fetchErr);
                    reject({ emailsData: [], newestEmailUid: lastUid, error: fetchErr });
                });

                f.once('end', () => {
                    console.log('Finished fetching all messages.');
                    resolve({ emailsData, newestEmailUid: newestEmailUid });
                });
            });
        });
    });
}

async function processEmail(emailData, urlProcessor) {
    // The buffer contains the raw email source.
    if (!emailData || !emailData.buffer) {
        console.log('[GmailProcessor] Email data or buffer is missing. Skipping.');
        return { processed: [], failed: [] };
    }

    const processed = [];
    const failed = [];

    try {
        const parsed = await simpleParser(emailData.buffer);
        const bodyText = parsed.text || '';
        const subject = parsed.subject || 'No Subject';
        // A more robust regex to find URLs, including those wrapped in < >
        const urls = bodyText.match(/https?:\/\/[^\s<>"']+/g) || [];

        if (urls.length === 0) {
            console.log(`[GmailProcessor] No URL found in email with subject: "${subject}"`);
            return { processed, failed };
        }

        // We only process the FIRST URL found in the email.
        const firstUrl = urls[0];
        console.log(`[GmailProcessor] Found URL: ${firstUrl} in email: "${subject}"`);
        
        const result = await urlProcessor(firstUrl, subject);
        
        if (result && result.status === 'success') {
            console.log(`[GmailProcessor] Successfully processed ${firstUrl}`);
            processed.push(result.url);
            
            // If this URL was previously failed, mark it as resolved
            if (supabase) {
                const { error: updateError } = await supabase
                    .from('failed_email_urls')
                    .update({
                        resolved_at: new Date().toISOString(),
                        resolved_status: 'success'
                    })
                    .eq('url', firstUrl)
                    .is('resolved_at', null);
                
                if (updateError) {
                    console.error('[GmailProcessor] Error updating resolved status:', updateError);
                }
            }
        } else {
            const reason = result ? result.status : 'unknown_error';
            console.warn(`[GmailProcessor] Processing of ${firstUrl} failed with status: ${reason}`);
            failed.push({ url: firstUrl, reason: reason });
            
            // Store failed URL in Supabase
            if (supabase) {
                // Check if this URL has failed before
                const { data: existingFail, error: checkError } = await supabase
                    .from('failed_email_urls')
                    .select('id, attempts')
                    .eq('url', firstUrl)
                    .is('resolved_at', null)
                    .maybeSingle();
                
                if (checkError) {
                    console.error('[GmailProcessor] Error checking for existing failed URL:', checkError);
                } else if (existingFail) {
                    // Update existing record with incremented attempts
                    const { error: updateError } = await supabase
                        .from('failed_email_urls')
                        .update({ 
                            attempts: existingFail.attempts + 1,
                            reason: reason // Update with latest failure reason
                        })
                        .eq('id', existingFail.id);
                    
                    if (updateError) {
                        console.error('[GmailProcessor] Error updating failed URL attempts:', updateError);
                    }
                } else {
                    // Insert new failed URL record
                    const { error: insertError } = await supabase
                        .from('failed_email_urls')
                        .insert({
                            url: firstUrl,
                            reason: reason,
                            subject: subject
                        });
                    
                    if (insertError) {
                        console.error('[GmailProcessor] Error inserting failed URL:', insertError);
                    }
                }
            }
        }

    } catch (error) {
        console.error('[GmailProcessor] Error parsing email or processing URL:', error);
        // If parsing fails, we can't get a URL, but we can log the failure.
        failed.push({ url: 'unknown', reason: error.message });
    }
    return { processed, failed };
}

async function main(urlProcessor = defaultUrlProcessor) {
    console.log('[GmailProcessor] Starting main execution...');
    let imap;
    let emailsData = [];
    let newestEmailUid = null;
    let totalProcessedCount = 0;
    let totalFailed = [];

    try {
        imap = await connectToGmail();
        const searchResult = await searchEmails(imap);
        emailsData = searchResult.emailsData || [];
        newestEmailUid = searchResult.newestEmailUid;
        
        if (emailsData.length > 0) {
            console.log(`[GmailProcessor] Processing ${emailsData.length} new email(s).`);
            for (const emailData of emailsData) {
                const { processed, failed } = await processEmail(emailData, urlProcessor);
                totalProcessedCount += processed.length;
                totalFailed.push(...failed);
            }
        } else {
            console.log('[GmailProcessor] No new emails to process.');
        }

        const lastUid = await getLastCheckUid();
        if (newestEmailUid && newestEmailUid > lastUid) {
            await updateLastCheckUid(newestEmailUid);
        }
        
    } catch (error) {
        console.error('[GmailProcessor] An error occurred in main:', error);
        return { 
            message: `Error during execution: ${error.message}`,
            processedCount: totalProcessedCount,
            failedCount: totalFailed.length,
            failedUrls: totalFailed,
        };
    } finally {
        if (imap) {
            imap.end();
        }
        console.log('[GmailProcessor] Main execution finished.');
    }
    
    return {
        message: `Completed. Processed ${totalProcessedCount} URL(s) from ${emailsData.length} email(s).`,
        processedCount: totalProcessedCount,
        failedCount: totalFailed.length,
        failedUrls: totalFailed,
    };
}

if (require.main === module) {
    main().then(result => {
        console.log(result.message);
        console.log(`Processed URLs: ${result.processedCount}`);
        console.log(`Failed URLs: ${result.failedCount}`);
        if (result.failedUrls.length > 0) {
            console.log('Failed URLs:');
            result.failedUrls.forEach(failed => console.log(`${failed.url} - Reason: ${failed.reason}`));
        }
    });
}

module.exports = { main }; 