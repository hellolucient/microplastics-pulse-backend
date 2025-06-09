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

        imap.once('error', (err) => {
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

            let sinceDate = await getLastCheckTimestamp();
            let newestEmailDateThisBatch = null;

            if (!sinceDate) {
                console.log('[GmailProcessor] Defaulting to search emails from the last 24 hours.');
                sinceDate = new Date();
                sinceDate.setDate(sinceDate.getDate() - 1); // Default to 24 hours ago
            } else {
                console.log(`[GmailProcessor] Using stored timestamp. Searching for emails since: ${sinceDate.toISOString()}`);
            }
            
            // Ensure sinceDate is a Date object for the library
            if (!(sinceDate instanceof Date)) {
                console.warn("[GmailProcessor] sinceDate was not a Date object, attempting to parse. This shouldn't happen.");
                try {
                    sinceDate = new Date(sinceDate);
                    if (isNaN(sinceDate.getTime())) throw new Error("Invalid date after parsing");
                } catch (dateParseError) {
                    console.error("[GmailProcessor] Failed to parse sinceDate, defaulting to 24 hours ago.", dateParseError);
                    sinceDate = new Date();
                    sinceDate.setDate(sinceDate.getDate() - 1);
                }
            }

            // The imap library expects a Date object for SINCE.
            // No need to format to YYYY-MM-DD string if passing a Date object.
            console.log(`Searching for emails SINCE criteria: ${sinceDate.toISOString()} (UTC) / ${sinceDate.toString()} (Local)`);

            imap.search([['SINCE', sinceDate]], (searchErr, results) => {
                if (searchErr) {
                    console.error('Email search error:', searchErr);
                    reject({ emailsData: [], newestEmailDate: null, error: searchErr });
                    return;
                }
                console.log(`Found ${results.length} email(s).`);
                if (results.length === 0) {
                    resolve({ emailsData: [], newestEmailDate: null });
                    return;
                }

                // --- Batching Logic ---
                const BATCH_SIZE = 10;
                // The 'results' array is typically sorted oldest to newest.
                // We'll process a small batch of the oldest ones to avoid timeouts.
                const batchResults = results.slice(0, BATCH_SIZE);
                console.log(`[GmailProcessor] Processing a batch of ${batchResults.length} of ${results.length} total found emails.`);
                // --- End Batching Logic ---

                const f = imap.fetch(batchResults, { bodies: '', markSeen: false }); // Fetch the limited batch, explicitly don't mark as seen
                const emailsData = [];
                let currentBatchLatestDate = null;

                f.on('message', (msg, seqno) => {
                    console.log(`Fetching message #${seqno}`);
                    let buffer = '';
                    // let headers = null; // Not used directly here, parsed later

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('utf8');
                        });
                        // stream.once('end', () => {}); // Not strictly needed here
                    });
                    msg.once('attributes', (attrs) => {
                        // attrs.date is the internal date of the email
                        if (attrs.date) {
                            const emailDate = new Date(attrs.date);
                            if (!currentBatchLatestDate || emailDate > currentBatchLatestDate) {
                                currentBatchLatestDate = emailDate;
                            }
                        }
                    });
                    msg.once('end', () => {
                        emailsData.push({ buffer }); // Headers will be parsed by simpleParser
                    });
                });

                f.once('error', (fetchErr) => {
                    console.error('Fetch error:', fetchErr);
                    reject({ emailsData: [], newestEmailDate: null, error: fetchErr });
                });

                f.once('end', () => {
                    console.log('Finished fetching all messages.');
                    newestEmailDateThisBatch = currentBatchLatestDate;
                    console.log(`Newest email date in this batch: ${newestEmailDateThisBatch ? newestEmailDateThisBatch.toISOString() : 'N/A'}`);
                    resolve({ emailsData, newestEmailDate: newestEmailDateThisBatch });
                });
            });
        });
    });
}

async function processEmail(emailData /*, processedEmails - Removed */) {
    try {
        const parsed = await simpleParser(emailData.buffer);
        const messageId = parsed.messageId; // Keep for logging for now, but not for primary duplicate check

        if (!messageId) {
            console.log('[GmailProcessor] Skipped: Email missing Message-ID.');
            return null; // Return null on skip
        }

        let rawDeliveredTo = parsed.headers.get('delivered-to');
        let foundTargetRecipient = false;
        const targetEmail = 'submit@microplasticswatch.com';

        console.log(`Raw 'delivered-to' header from mailparser:`, rawDeliveredTo);

        if (rawDeliveredTo) {
            if (Array.isArray(rawDeliveredTo)) {
                for (const item of rawDeliveredTo) {
                    if (typeof item === 'string' && item.toLowerCase().includes(targetEmail)) {
                        foundTargetRecipient = true;
                        break;
                    } else if (typeof item === 'object' && item && typeof item.text === 'string' && item.text.toLowerCase().includes(targetEmail)) {
                        foundTargetRecipient = true;
                        break;
                    } else if (typeof item === 'object' && item && item.value && typeof item.value === 'string' && item.value.toLowerCase().includes(targetEmail)) {
                        foundTargetRecipient = true;
                        break;
                    } else if (typeof item === 'object' && item && item.address && typeof item.address === 'string' && item.address.toLowerCase().includes(targetEmail)) {
                        foundTargetRecipient = true;
                        break;
                    }
                }
            } else if (typeof rawDeliveredTo === 'string') {
                if (rawDeliveredTo.toLowerCase().includes(targetEmail)) {
                    foundTargetRecipient = true;
                }
            } else if (typeof rawDeliveredTo === 'object' && rawDeliveredTo && typeof rawDeliveredTo.text === 'string') {
                if (rawDeliveredTo.text.toLowerCase().includes(targetEmail)) {
                    foundTargetRecipient = true;
                }
            } else if (typeof rawDeliveredTo === 'object' && rawDeliveredTo && rawDeliveredTo.value && typeof rawDeliveredTo.value === 'string') {
                if (rawDeliveredTo.value.toLowerCase().includes(targetEmail)) {
                    foundTargetRecipient = true;
                }
            } else if (typeof rawDeliveredTo === 'object' && rawDeliveredTo && rawDeliveredTo.address && typeof rawDeliveredTo.address === 'string') {
                if (rawDeliveredTo.address.toLowerCase().includes(targetEmail)) {
                    foundTargetRecipient = true;
                }
            }
        }
        
        const fromAddress = parsed.from?.value[0]?.address?.toLowerCase() || 'unknown@sender.com';
        const textBody = parsed.text || '';

        console.log(`Processing email from ${fromAddress} with Message-ID: ${messageId}`);
        console.log(`Was target recipient (${targetEmail}) found in Delivered-To? ${foundTargetRecipient}`);

        if (!foundTargetRecipient) {
            console.log(`Skipped: Email not delivered to ${targetEmail}. Raw Delivered-To was:`, rawDeliveredTo);
            return null; // Return null on skip
        }

        if (!approvedSenders.map(s => s.toLowerCase()).includes(fromAddress)) {
            console.log(`Skipped: Sender ${fromAddress} is not in the approved list.`);
            return null; // Return null on skip
        }

        console.log('Email passed initial checks (Delivered-To, Approved Sender).');

        const urlRegex = /https?:\/\/[^\s]+/g;
        const urlsFound = textBody.match(urlRegex);

        if (!urlsFound || urlsFound.length === 0) {
            console.log('[GmailProcessor] Skipped: No URL found in the email body.');
            return null; // Return null on skip
        }

        const extractedUrl = urlsFound[0]; // Take the first URL
        console.log(`[GmailProcessor] Extracted URL: ${extractedUrl}`);

        // --- Supabase Duplicate Check ---
        if (supabase) {
            try {
                console.log(`[GmailProcessor] Checking Supabase for duplicate URL: ${extractedUrl}`);
                const { data: existingArticle, error: dbError } = await supabase
                    .from('latest_news')
                    .select('url')
                    .eq('url', extractedUrl)
                    .maybeSingle();

                if (dbError) {
                    console.error(`[GmailProcessor] Supabase error checking for duplicate URL ${extractedUrl}:`, dbError.message);
                    // Decide if we should proceed or not. For now, let's proceed but log the error.
                    // Consider returning here if DB check is critical and fails.
                }

                if (existingArticle) {
                    console.log(`[GmailProcessor] Skipped: URL ${extractedUrl} already exists in Supabase database.`);
                    return null; // URL already processed and in DB
                }
                console.log(`[GmailProcessor] URL ${extractedUrl} is new to Supabase.`);
            } catch (supaCheckError) {
                console.error(`[GmailProcessor] Unexpected error during Supabase duplicate check for ${extractedUrl}:`, supaCheckError.message);
                // Proceed with caution or return
            }
        } else {
            console.warn('[GmailProcessor] Supabase client not initialized. Skipping database duplicate check. This might lead to reprocessing existing URLs.');
        }
        // --- End Supabase Duplicate Check ---

        try {
            console.log(`[GmailProcessor] Sending POST request to ${GENERATION_ENDPOINT} with URL: ${extractedUrl}`);
            const response = await axios.post(GENERATION_ENDPOINT, { url: extractedUrl });
            console.log('Successfully sent data to generation endpoint:', response.status, response.data);
            return null; // Success
        } catch (apiError) {
            console.error('Error sending POST request to generation endpoint:', apiError.message);
            if (apiError.response) {
                console.error('API Error Response Data:', apiError.response.data);
                console.error('API Error Response Status:', apiError.response.status);
                // Let's consider any 5xx error as a potential temporary server issue
                if (apiError.response.status >= 500 && apiError.response.status <= 599) {
                    console.warn(`[GmailProcessor] URL ${extractedUrl} failed with ${apiError.response.status} from generation endpoint. Adding to failed list for retry.`);
                    return extractedUrl; // Failed with a server error, return URL
                }
            }
            // For other errors (e.g., 4xx client errors) or if no response, it's likely not something a retry will fix.
            // Log it, but treat as "processed" so we don't get stuck on it.
            return null; 
        }

    } catch (parseError) {
        console.error('[GmailProcessor] Error parsing email:', parseError);
        return null; // Error during parsing
    }
}

async function main() {
    console.log('[GmailProcessor] Starting email processing script...');
    let imap;
    let newestEmailDateProcessed = null; // To keep track of the latest email date we actually processed
    const failedUrls = []; // Initialize list for failed URLs
    let processingStatus = { // Object to hold results
        processedCount: 0,
        failedCount: 0,
        failedUrls: [],
        message: ''
    };
    let searchResult; // Hoist searchResult to be available in finally
    let scriptError = null; // To track if an error occurred

    try {
        imap = await connectToGmail();
        searchResult = await searchEmails(imap); // searchEmails now returns an object
        const emailsData = searchResult.emailsData;
        const newestEmailFetchedThisBatch = searchResult.newestEmailDate; // This is the latest date from IMAP attributes

        if (emailsData && emailsData.length > 0) {
            processingStatus.message = `[GmailProcessor] Processing ${emailsData.length} fetched emails.`;
            console.log(processingStatus.message);
            for (const emailData of emailsData) {
                const failedUrl = await processEmail(emailData);
                if (failedUrl) {
                    failedUrls.push(failedUrl);
                    processingStatus.failedCount++;
                } else {
                    // Assuming null means success or skipped for valid reasons (already processed, not approved etc)
                    // We might want to be more granular if processEmail returns different types of nulls
                    processingStatus.processedCount++; 
                }
            }
            if (newestEmailFetchedThisBatch) {
                newestEmailDateProcessed = newestEmailFetchedThisBatch;
            }
        } else {
            processingStatus.message = '[GmailProcessor] No new emails to process.';
            console.log(processingStatus.message);
        }

        processingStatus.failedUrls = failedUrls;
        if (failedUrls.length > 0) {
            const failMsg = `[GmailProcessor] ${failedUrls.length} URL(s) failed to process (returned 502).`;
            console.warn(failMsg);
            failedUrls.forEach(url => console.warn(`- ${url}`));
            processingStatus.message += ` ${failMsg}`;
        } else if (emailsData && emailsData.length > 0) {
            processingStatus.message += ' All found URLs processed successfully or were skipped appropriately.';
        }

    } catch (error) {
        const errorMsg = 'An error occurred in the Gmail processing main process.';
        console.error(errorMsg, error);
        processingStatus.message = `${errorMsg} Details: ${error.message}`;
        // Still return failedUrls accumulated so far, if any
        processingStatus.failedUrls = failedUrls; 
        if (error && error.error && error.emailsData !== undefined && error.newestEmailDate !== undefined) {
            console.error('Specific error during email search:', error.error);
            processingStatus.message = `Error during email search: ${error.error.message || error.error}`;
        }
        scriptError = error; // Capture the error
    } finally {
        if (imap) {
            imap.end();
        }

        if (newestEmailDateProcessed) {
            // Happy path: we found and processed emails. Update timestamp to the newest one.
            await updateLastCheckTimestamp(newestEmailDateProcessed);
        } else if (!scriptError && searchResult && searchResult.emailsData && searchResult.emailsData.length === 0) {
            // No new mail case: The script ran successfully but found nothing new.
            // Update the timestamp to now to prevent re-scanning the same old window.
            console.log("[GmailProcessor] No new emails were found. Updating timestamp to current time.");
            await updateLastCheckTimestamp(new Date());
        } else {
            // Error case: An error occurred during the process, so we DON'T update the timestamp.
            // This ensures we retry the same time frame on the next run.
            console.log("[GmailProcessor] Script finished with errors or did not complete search. Timestamp will not be updated to preserve the last successful check point.");
        }
        
        console.log('Email processing script finished.');
        return processingStatus; // Return the processing status object
    }
}

// main(); // Remove direct call if it's only meant to be called by cron or manually as a module

module.exports = { main }; // Export the main function 