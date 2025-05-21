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

function searchEmails(imap) {
    return new Promise((resolve, reject) => {
        imap.openBox('INBOX', true, (err, box) => {
            if (err) {
                console.error('Error opening INBOX:', err);
                reject(err);
                return;
            }
            console.log('INBOX opened.');

            const sinceDate = new Date();
            sinceDate.setMinutes(sinceDate.getMinutes() - 15); // Emails from the last 15 minutes
            // Gmail uses dates in YYYY-MM-DD format for SINCE.
            // The IMAP library's search criteria might handle Date objects directly,
            // but for Gmail, it's often more reliable to use a list like ['SINCE', '15-Feb-2024']
            // Let's use the Date object directly first, if it fails, we may need to format.
            // The imap library specifies using a Date object for SINCE.

            console.log(`Searching for emails since: ${sinceDate.toDateString()}`);

            imap.search([['SINCE', sinceDate]], (searchErr, results) => {
                if (searchErr) {
                    console.error('Email search error:', searchErr);
                    reject(searchErr);
                    return;
                }
                console.log(`Found ${results.length} email(s).`);
                if (results.length === 0) {
                    resolve([]);
                    return;
                }

                const f = imap.fetch(results, { bodies: '' }); // Fetch entire messages
                const emailsData = [];

                f.on('message', (msg, seqno) => {
                    console.log(`Fetching message #${seqno}`);
                    let buffer = '';
                    let headers = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('utf8');
                        });
                        stream.once('end', () => {
                            // Headers are usually available before the 'body' event via attributes
                            // but we'll also get them from simpleParser
                        });
                    });
                    msg.once('attributes', (attrs) => {
                        // Store attributes if needed, like UID
                        // attrs.uid
                    });
                    msg.once('end', () => {
                        emailsData.push({ buffer, headers }); // Headers will be parsed by simpleParser
                    });
                });

                f.once('error', (fetchErr) => {
                    console.error('Fetch error:', fetchErr);
                    reject(fetchErr);
                });

                f.once('end', () => {
                    console.log('Finished fetching all messages.');
                    resolve(emailsData);
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
            return;
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
            return;
        }

        if (!approvedSenders.map(s => s.toLowerCase()).includes(fromAddress)) {
            console.log(`Skipped: Sender ${fromAddress} is not in the approved list.`);
            return;
        }

        console.log('Email passed initial checks (Delivered-To, Approved Sender).');

        const urlRegex = /https?:\/\/[^\s]+/g;
        const urlsFound = textBody.match(urlRegex);

        if (!urlsFound || urlsFound.length === 0) {
            console.log('[GmailProcessor] Skipped: No URL found in the email body.');
            return;
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
                    return; // URL already processed and in DB
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
        } catch (apiError) {
            console.error('Error sending POST request to generation endpoint:', apiError.message);
            if (apiError.response) {
                console.error('API Error Response Data:', apiError.response.data);
                console.error('API Error Response Status:', apiError.response.status);
            }
        }

    } catch (parseError) {
        console.error('[GmailProcessor] Error parsing email:', parseError);
    }
}

async function main() {
    console.log('[GmailProcessor] Starting email processing script...');
    let imap;
    try {
        // const processedEmails = await loadProcessedEmails(); // Removed
        imap = await connectToGmail();
        const emailsData = await searchEmails(imap);

        if (emailsData.length > 0) {
            console.log(`[GmailProcessor] Processing ${emailsData.length} fetched emails.`);
            for (const emailData of emailsData) {
                // Pass only emailData, no longer passing processedEmails
                await processEmail(emailData /*, processedEmails - Removed */);
            }
        } else {
            console.log('[GmailProcessor] No new emails to process.');
        }

    } catch (error) {
        console.error('An error occurred in the main process:', error);
    } finally {
        if (imap) {
            imap.end();
        }
        console.log('Email processing script finished.');
    }
}

// main(); // Remove direct call if it's only meant to be called by cron or manually as a module

module.exports = { main }; // Export the main function 