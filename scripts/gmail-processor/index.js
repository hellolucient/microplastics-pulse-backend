require('dotenv').config({ path: '../../.env' }); // Load .env from backend root
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const processedEmailsPath = path.join(__dirname, 'processed.json');
const approvedSenders = ['hellolucient@gmail.com', 'trent.munday@gmail.com', 'gerrybodeker@gmail.com']; // Define your approved senders

const imapConfig = {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false } // Necessary for some environments, consider security implications
};

const GENERATION_ENDPOINT = process.env.GENERATION_ENDPOINT || 'https://yourapp.com/api/generate';

async function loadProcessedEmails() {
    try {
        const data = await fs.readFile(processedEmailsPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('processed.json not found, starting with an empty set.');
            return {}; // If file doesn't exist, start with an empty object
        }
        console.error('Error loading processed emails:', error);
        return {}; // In case of other errors, also start fresh or handle appropriately
    }
}

async function saveProcessedEmail(messageId, processedEmails) {
    processedEmails[messageId] = new Date().toISOString();
    try {
        await fs.writeFile(processedEmailsPath, JSON.stringify(processedEmails, null, 2));
        console.log(`Saved Message-ID ${messageId} to processed.json`);
    } catch (error) {
        console.error('Error saving processed email:', error);
    }
}

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

async function processEmail(emailData, processedEmails) {
    try {
        const parsed = await simpleParser(emailData.buffer);
        const messageId = parsed.messageId;

        if (!messageId) {
            console.log('Skipped: Email missing Message-ID.');
            return;
        }

        if (processedEmails[messageId]) {
            console.log(`Skipped: Message-ID ${messageId} already processed.`);
            return;
        }

        const deliveredTo = parsed.headers.get('delivered-to') || '';
        const fromAddress = parsed.from?.value[0]?.address || 'unknown@sender.com';
        const textBody = parsed.text || '';

        console.log(`Processing email from ${fromAddress} with Message-ID: ${messageId}`);
        console.log(`Delivered-To: ${deliveredTo}`);

        if (typeof deliveredTo !== 'string' || !deliveredTo.toLowerCase().includes('submit@microplasticswatch.com')) {
            console.log(`Skipped: Email not delivered to submit@microplasticswatch.com. Delivered to: ${deliveredTo}`);
            return;
        }

        if (!approvedSenders.includes(fromAddress.toLowerCase())) {
            console.log(`Skipped: Sender ${fromAddress} is not in the approved list.`);
            return;
        }

        console.log('Email passed initial checks (Delivered-To, Approved Sender).');

        const urlRegex = /https?:\/\/[^\s]+/g;
        const urlsFound = textBody.match(urlRegex);

        if (!urlsFound || urlsFound.length === 0) {
            console.log('Skipped: No URL found in the email body.');
            return;
        }

        const extractedUrl = urlsFound[0]; // Take the first URL
        console.log(`Extracted URL: ${extractedUrl}`);

        try {
            console.log(`Sending POST request to ${GENERATION_ENDPOINT} with URL: ${extractedUrl}`);
            const response = await axios.post(GENERATION_ENDPOINT, { url: extractedUrl });
            console.log('Successfully sent data to generation endpoint:', response.status, response.data);
        } catch (apiError) {
            console.error('Error sending POST request to generation endpoint:', apiError.message);
            if (apiError.response) {
                console.error('API Error Response Data:', apiError.response.data);
                console.error('API Error Response Status:', apiError.response.status);
            }
        }

        await saveProcessedEmail(messageId, processedEmails); // Save after successful processing and API call attempt

    } catch (parseError) {
        console.error('Error parsing email:', parseError);
    }
}

async function main() {
    console.log('Starting email processing script...');
    let imap;
    try {
        const processedEmails = await loadProcessedEmails();
        imap = await connectToGmail();
        const emailsData = await searchEmails(imap);

        if (emailsData.length > 0) {
            for (const emailData of emailsData) {
                await processEmail(emailData, processedEmails);
            }
        } else {
            console.log('No new emails to process.');
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

main(); 