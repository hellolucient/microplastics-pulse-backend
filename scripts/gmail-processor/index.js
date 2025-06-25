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
    const response = await axios.head(url, { timeout: 15000, maxRedirects: 5 });
    finalUrl = response.request.res.responseUrl || url;
    console.log(`[UrlProcessor] Resolved URL: ${url} -> ${finalUrl}`);
  } catch (headError) {
    console.warn(`[UrlProcessor] HEAD request failed for ${url}. Using original URL. Error: ${headError.message}`);
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
      submitted_by: 'email', // Mark as submitted via email
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
                console.log(`Found ${results.length} email(s) to process.`);
                if (results.length === 0) {
                    resolve({ emailsData: [], newestEmailUid: null });
                    return;
                }

                const f = imap.fetch(results, { bodies: '', markSeen: false }); // Fetch all results
                const emailsData = [];
                let currentBatchLatestUid = null;

                f.on('message', (msg, seqno) => {
                    console.log(`Fetching message #${seqno}`);
                    let buffer = '';
                    
                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('utf8');
                        });
                    });
                    msg.once('attributes', (attrs) => {
                        // attrs.uid is the UID of the email
                        if (attrs.uid) {
                            // The UIDs might not be in order, so we find the max UID in the batch.
                            if (currentBatchLatestUid === null || attrs.uid > currentBatchLatestUid) {
                                currentBatchLatestUid = attrs.uid;
                            }
                        }
                    });
                    msg.once('end', () => {
                        emailsData.push({ buffer }); 
                    });
                });

                f.once('error', (fetchErr) => {
                    console.error('Fetch error:', fetchErr);
                    reject({ emailsData: [], newestEmailUid: null, error: fetchErr });
                });

                f.once('end', () => {
                    console.log('Finished fetching all messages.');
                    console.log(`Newest email UID in this batch: ${currentBatchLatestUid || 'N/A'}`);
                    resolve({ emailsData, newestEmailUid: currentBatchLatestUid });
                });
            });
        });
    });
}

async function processEmail(emailData, urlProcessor) {
    if (!emailData || !emailData.text) {
        console.log('[GmailProcessor] No text found in email body. Skipping.');
        return;
    }

    try {
        const parsed = await simpleParser(emailData.body);
        const bodyText = parsed.text || '';
        const urls = bodyText.match(/https?:\/\/[^\s]+/g) || [];

        if (urls.length === 0) {
            console.log(`[GmailProcessor] No URL found in email from: ${emailData.from.value[0].address}`);
            return;
        }

        for (const extractedUrl of urls) {
            console.log(`[GmailProcessor] Calling processor for URL: ${extractedUrl}`);
            // Pass both the URL and the email subject to the processor function
            const result = await urlProcessor(extractedUrl, parsed.subject);

            // The logic for handling 'result' can be enhanced based on its structure
            if (result && result.status === 'success') {
                console.log(`[GmailProcessor] Successfully processed ${extractedUrl}`);
            } else {
                console.warn(`[GmailProcessor] Processing of ${extractedUrl} resulted in status: ${result ? result.status : 'unknown'}`);
            }
        }
    } catch (error) {
        console.error('[GmailProcessor] Error parsing email or processing URL:', error);
    }
}

async function main(urlProcessor = defaultUrlProcessor) {
    console.log('[GmailProcessor] Starting main execution...');
    let imap;
    let emailsProcessedCount = 0;
    try {
        imap = await connectToGmail();
        const { emailsData, newestEmailUid } = await searchEmails(imap);
        
        if (emailsData.length > 0) {
            console.log(`[GmailProcessor] Processing ${emailsData.length} new email(s).`);
            for (const emailData of emailsData) {
                await processEmail(emailData, urlProcessor);
                emailsProcessedCount++;
            }
        } else {
            console.log('[GmailProcessor] No new emails to process.');
        }

        if (newestEmailUid) {
            await updateLastCheckUid(newestEmailUid);
        }
        
    } catch (error) {
        console.error('[GmailProcessor] An error occurred in main:', error);
        return { success: false, message: `Error during execution: ${error.message}` };
    } finally {
        if (imap) {
            imap.end();
        }
        console.log('[GmailProcessor] Main execution finished.');
    }
    return { success: true, message: `Completed. Processed ${emailsProcessedCount} email(s).` };
}

if (require.main === module) {
    // ... existing code ...
}

module.exports = { main }; 