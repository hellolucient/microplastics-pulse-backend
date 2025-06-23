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
    try {
        const parsed = await simpleParser(emailData.buffer);
        const messageId = parsed.messageId;

        if (!messageId) {
            console.log('[GmailProcessor] Skipped: Email missing Message-ID.');
            return { success: true, skipped: true };
        }

        let rawDeliveredTo = parsed.headers.get('delivered-to');
        let foundTargetRecipient = false;
        const targetEmail = 'submit@microplasticswatch.com';

        if (rawDeliveredTo) {
            const recipientJson = JSON.stringify(rawDeliveredTo).toLowerCase();
            if (recipientJson.includes(targetEmail)) {
                foundTargetRecipient = true;
            }
        }
        
        const fromAddress = parsed.from?.value[0]?.address?.toLowerCase() || 'unknown@sender.com';
        const textBody = parsed.text || '';

        if (!foundTargetRecipient) {
            return { success: true, skipped: true };
        }
        if (!approvedSenders.map(s => s.toLowerCase()).includes(fromAddress)) {
            return { success: true, skipped: true };
        }

        const urlRegex = /https?:\/\/[^\s]+/g;
        const urlsFound = textBody.match(urlRegex);

        if (!urlsFound || urlsFound.length === 0) {
            return { success: true, skipped: true };
        }

        const extractedUrl = urlsFound[0];

        // This is the key change: Call the function directly instead of using axios.
        if (typeof urlProcessor !== 'function') {
             console.error('[GmailProcessor] CRITICAL: urlProcessor is not a function. Cannot process URL.');
             // Return failure, but don't count it as a "failed URL" that should be retried, as it's a code issue.
             return { success: false, error: 'Internal server error: processor function not provided.' };
        }
        
        console.log(`[GmailProcessor] Calling processor for URL: ${extractedUrl}`);
        const result = await urlProcessor(extractedUrl);

        if (result.success) {
            console.log(`[GmailProcessor] Successfully processed URL: ${extractedUrl}. Message: ${result.message}`);
            return { success: true, skipped: false };
        } else {
            console.error(`[GmailProcessor] Failed to process URL ${extractedUrl}. Status: ${result.status}, Message: ${result.message}`);
            // If the processor determined it was a server-side issue (5xx), we can consider it a failed URL for retry.
            if (result.status && result.status >= 500) {
                return { success: false, failedUrl: extractedUrl };
            }
            // For other errors (e.g., 4xx), we treat it as processed so we don't get stuck.
            return { success: true, skipped: true };
        }

    } catch (parseError) {
        console.error('[GmailProcessor] Error parsing email:', parseError);
        return { success: false, error: 'Email parsing failed' };
    }
}

async function main(urlProcessor) {
    console.log('[GmailProcessor] Starting email processing script...');
    const failedUrls = [];
    let processingStatus = {
        processedCount: 0,
        failedCount: 0,
        failedUrls: [],
        message: ''
    };
    let searchResult;
    let scriptError = null;

    try {
        const imap = await connectToGmail();
        try {
            searchResult = await searchEmails(imap);
        } finally {
            if (imap) imap.end();
        }

        const emailsData = searchResult?.emailsData;
        const newestEmailFetchedThisBatch = searchResult?.newestEmailUid;

        if (emailsData && emailsData.length > 0) {
            processingStatus.message = `[GmailProcessor] Processing ${emailsData.length} fetched emails.`;
            for (const emailData of emailsData) {
                const result = await processEmail(emailData, urlProcessor);
                if (result.success && !result.skipped) {
                    processingStatus.processedCount++;
                } else if (!result.success && result.failedUrl) {
                    failedUrls.push(result.failedUrl);
                    processingStatus.failedCount++;
                }
            }
            if (newestEmailFetchedThisBatch) {
                await updateLastCheckUid(newestEmailFetchedThisBatch);
            }
        } else {
            processingStatus.message = '[GmailProcessor] No new emails to process.';
        }

        processingStatus.failedUrls = failedUrls;
        if (failedUrls.length > 0) {
            processingStatus.message += ` ${failedUrls.length} URL(s) failed.`;
        }

    } catch (error) {
        scriptError = error;
        const errorMsg = 'An error occurred in the Gmail processing main process.';
        console.error(errorMsg, error);
        processingStatus.message = `${errorMsg} Details: ${error.message}`;
        processingStatus.failedUrls = failedUrls; 
    } finally {
        if (scriptError) {
            console.log("[GmailProcessor] Script finished with errors. UID will not be updated.");
        }
        console.log('Email processing script finished.');
        return processingStatus;
    }
}

module.exports = { main }; 