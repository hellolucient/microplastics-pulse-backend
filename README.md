# MicroPlastics Pulse Project

## 1. Overview

The MicroPlastics Pulse Project is a web application designed to aggregate, process, and display the latest news and research related to microplastics. This backend service provides a robust API with **automated daily scheduling**, **AI-powered content enhancement**, and **comprehensive administration tools**.

<!-- Updated: SSE parsing fixes deployed -->

**Current Status**: Production-ready system deployed on Railway with reliable daily automation at 2:00 AM UTC and AI usage tracking.

## 2. How It Works (High-Level Flow)

The project operates through a combination of automated fetching, AI processing, and manual administrative controls:

1.  **Article Aggregation:**
    *   The backend periodically (or through manual trigger) fetches articles from the web using the Google Custom Search API based on a predefined list of specialized search queries.

2.  **AI Content Enhancement:**
    *   For each new article identified:
        *   An **AI-generated summary** is created using OpenAI's GPT-3.5-turbo model to provide a concise overview.
        *   An **AI-generated illustrative image** is created using OpenAI's DALL-E 3 model to visually represent the article's theme. The image prompt is designed to produce realistic, editorial-style photos without text or overly dramatic expressions.

3.  **Storage:**
    *   Generated images are uploaded to and stored in **Vercel Blob storage**.
    *   Article metadata (URL, title, original snippet), AI-generated summaries, and the URLs to the AI-generated images (stored in Vercel Blob) are saved in a **Supabase (PostgreSQL) database**.

4.  **Content Delivery:**
    *   The **frontend application** fetches the processed articles from the backend API and displays them in a user-friendly news feed.

5.  **Administration:**
    *   An **admin panel** provides tools for content management, including manual article submission, triggering news fetch cycles, batch updating stories (e.g., to generate missing images), and regenerating specific images.

## 3. Key Features

*   **Automated News Aggregation:** Regularly scans for new articles based on defined search terms.
*   **AI-Generated Summaries:** Provides concise summaries of articles using GPT-3.5-turbo.
*   **AI-Generated Images:** Creates unique, relevant images for articles using DALL-E 3.
*   **Admin Dashboard:** A secure area for project administrators to:
    *   **Manually Submit Articles:** Add specific URLs for processing.
    *   **Trigger Manual News Fetch:** Initiate the article fetching and processing cycle for each predefined search query, one by one.
    *   **Batch AI Updates for Missing Images:** Process stories in the database that are missing an AI-generated image. This function will generate both a new summary and a new image for these articles.
    *   **Regenerate Image by ID:** Allows an administrator to regenerate the AI image for a specific article using its UUID, without affecting its summary.
*   **Public News Feed:** Displays the curated and AI-enhanced articles to users.
*   **Research Library:** Advanced document search and viewing system with:
    *   **PDF Document Upload:** Upload and store research documents (PDFs) with automatic text extraction
    *   **Semantic Search:** Search through document content with AI-powered relevance scoring
    *   **Document Filtering:** Filter search results by specific documents
    *   **Whole Word Matching:** Intelligent search that matches complete words only (e.g., "national" won't match "international")
    *   **Page-Aware Processing:** Accurate page number calculation using actual PDF page data
    *   **Snippet Extraction:** Generate relevant text snippets with highlighted search terms
*   **Secure Image Storage:** Utilizes Vercel Blob for reliable image hosting.
*   **Robust Database:** Employs Supabase (PostgreSQL) for structured data storage.

## 4. Project Structure

The project is organized into two main repositories, typically managed within a parent project directory:

1.  **`microplastics-pulse-frontend`**
    *   **Description:** Contains the frontend application built with React (using TypeScript and Vite).
    *   **Responsibilities:** User interface, presenting the news feed, admin dashboard interactions, and communication with the backend API.

2.  **`microplastics-pulse-backend`**
    *   **Description:** Contains the backend API built with Node.js and Express.js, deployed on Railway with persistent process and automated scheduling.
    *   **Responsibilities:** API endpoints for fetching/serving news, automated daily tasks (Google fetch, email check, Twitter posting), AI processing (summaries, images), database interactions (Supabase), and comprehensive admin tools.

### Backend File Structure & Deployment

**⚠️ IMPORTANT: Understanding the Dual index.js Files**

The backend has a specific deployment structure that can cause confusion:

```
microplastics-pulse-backend/
├── index.js          # Development/local server (npm start)
├── api/
│   └── index.js      # Production/Railway deployment (Railway runs this)
├── Dockerfile        # Specifies: CMD ["node", "api/index.js"]
└── vercel.json       # Routes /api/* to /api/index.js
```

**Key Points:**
- **Local Development**: Uses root `index.js` (`npm start` → `node index.js`)
- **Railway Production**: Uses `api/index.js` (Dockerfile specifies this)
- **Vercel Deployment**: Routes `/api/*` requests to `api/index.js`
- **⚠️ CRITICAL**: When making changes, you MUST update BOTH files or Railway won't see your changes!

**Why This Structure Exists:**
- Originally designed for Vercel deployment (serverless functions in `/api/` directory)
- Railway adopted the same structure for consistency
- Allows both serverless (Vercel) and persistent (Railway) deployments from the same codebase

**Development Workflow:**
1. Make changes to `api/index.js` for production
2. Run `npm run sync:api-to-root` to copy changes to root `index.js` for local testing
3. Commit and push - Railway will automatically deploy `api/index.js`

**Sync Utility:**
- `npm run sync:api-to-root` - Copy production file to development file
- `npm run sync:root-to-api` - Copy development file to production file  
- `npm run sync:check` - Check if both files are in sync

## 5. Tech Stack

*   **Frontend:**
    *   React (with TypeScript)
    *   Vite (build tool)
    *   Tailwind CSS (styling)
    *   Axios (HTTP client)
*   **Backend:**
    *   Node.js
    *   Express.js
*   **AI Services:**
    *   OpenAI API:
        *   GPT-3.5-turbo (for text summaries)
        *   DALL-E 3 (for image generation)
*   **Database:**
    *   Supabase (PostgreSQL)
*   **Image Storage:**
    *   Vercel Blob
*   **External Search:**
    *   Google Custom Search API
*   **Deployment & Hosting:**
    *   Frontend: Vercel
    *   Backend: Railway (persistent Node.js process with cron scheduling)
*   **Automation:**
    *   node-cron (daily scheduled tasks)
    *   Twitter API v2 (automated posting)
    *   Gmail IMAP (email processing)

## 6. Key Backend API Endpoints

The backend exposes several key API endpoints under the `/api` path:

*   `GET /latest-news`: Fetches the list of processed news articles for the public feed.
*   `POST /add-news`: Allows manual submission of a new article URL for processing. Now includes enhanced Google Share URL handling to extract real article URLs.
*   `POST /api/collect-email`: **NEW** - Collects email addresses for whitepaper downloads and stores them in the `whitepaper_leads` table.
*   `POST /trigger-fetch`: (Used by Admin Panel) Triggers the processing of a single search query by its index.
*   `POST /admin/trigger-automation`: **NEW** - Manually run the full automation suite (Google + Email + Twitter)
*   `POST /admin/check-duplicates`: **NEW** - Database integrity checker with comprehensive duplicate detection
*   `POST /admin/check-emails`: Trigger email processing for submitted article URLs
*   `POST /batch-update-stories`: Processes a batch of stories from the database for missing AI images
*   `POST /regenerate-image`: Regenerates the AI image for a specific article by UUID
*   `GET /search-queries`: Returns the predefined list of search queries used for fetching articles
*   **Research Library Endpoints:**
    *   `GET /api/rag-documents/public`: Fetches list of public research documents
    *   `GET /api/rag-documents/public/search`: Advanced search through document content with filtering
    *   `GET /api/rag-documents/public/{id}`: Retrieves specific document for viewing
    *   `POST /api/admin/rag-documents/upload`: Upload new PDF documents (admin only)
    *   `GET /api/rag-documents/public/list`: Get document list for filtering options

## 7. Setup & Running Locally (Brief Guide)

To set up and run the project locally, you'll generally need to:

1.  **Clone Repositories:**
    *   `git clone <repository_url_for_frontend>` (e.g., `git clone https://github.com/hellolucient/microplastics-pulse-frontend.git`)
    *   `git clone <repository_url_for_backend>` (e.g., `git clone https://github.com/hellolucient/microplastics-pulse-backend.git`)

2.  **Environment Variables:**
    *   Both frontend and backend applications will require environment variables to be set up. Create `.env` files in the root of each repository based on their respective `.env.example` files (if available, or based on required keys).
    *   **Key variables for the backend typically include:**
        *   `SUPABASE_URL`
        *   `SUPABASE_SERVICE_KEY`
        *   `OPENAI_API_KEY`
        *   `GOOGLE_API_KEY`
        *   `GOOGLE_SEARCH_ENGINE_ID`
        *   `BLOB_READ_WRITE_TOKEN` (for Vercel Blob)
        *   `PORT` (for local backend server, e.g., 3001)
    *   **Key variables for the frontend typically include:**
        *   `VITE_BACKEND_API_URL` (e.g., `http://localhost:3001`)
        *   Supabase client keys if direct Supabase calls are made from the frontend (e.g., for auth).

3.  **Install Dependencies:**
    *   Navigate into each repository's directory:
        *   `cd microplastics-pulse-frontend && npm install` (or `yarn install`)
        *   `cd ../microplastics-pulse-backend && npm install` (or `yarn install`)

4.  **Run Development Servers:**
    *   **Backend:** `cd microplastics-pulse-backend && npm start` (runs root `index.js` for local development)
    *   **Frontend:** `cd microplastics-pulse-frontend && npm run dev` (or `yarn dev`). This will usually start the Vite development server, and you can access the frontend in your browser (typically `http://localhost:5173` or similar).

**⚠️ Development Note:** The backend uses `npm start` (not `npm run dev`) and runs the root `index.js` file for local development. For production deployment, Railway automatically runs `api/index.js` as specified in the Dockerfile.

## 8. Automated Daily Tasks (2:00 AM UTC)

**Reliable Scheduling with node-cron on Railway:**
*   **Google News Fetch**: Searches for new articles using predefined queries
*   **Email Processing**: Checks Gmail for user-submitted article URLs
*   **Twitter Posting**: Automatically posts tweets about latest articles with duplicate handling
*   **Error Handling**: Individual task failures don't stop the automation suite
*   **Manual Testing**: Admin panel provides "Run Full Automation Suite" button

## 9. Recent Improvements (August 2025)

**🔧 URL Processing Enhancements:**
*   **Google Share URL Handling**: Automatic extraction of real URLs from Google Share links (`share.google/...` format)
*   **Source Domain Extraction**: Clean domain names for better source attribution (e.g., "nature.com" instead of "google.com")
*   **Email URL Processing**: Proper handling of `share.google/...` URLs from email submissions
*   **Enhanced `/api/add-news`**: Now extracts real article URLs before storing in database

**📧 Email Collection System:**
*   **New `/api/collect-email` Endpoint**: Collects email addresses for whitepaper downloads
*   **Database Integration**: Stores emails in dedicated `whitepaper_leads` table
*   **Duplicate Prevention**: Checks for existing emails before insertion
*   **Frontend Integration**: Modal-based email collection with validation

**🎨 Frontend Integration:**
*   **News Carousel**: Auto-playing carousel with whitepaper download integration
*   **Email Collection Modal**: Mandatory email collection before whitepaper downloads
*   **Improved Source Display**: Clean domain extraction and better date formatting
*   **HTML Tag Cleaning**: Automatic removal of HTML tags from titles and summaries

## 10. Previous Improvements (August 2024)

**🔧 Reliability Fixes:**
*   Fixed 4-day scheduling gaps by correcting Railway deployment configuration
*   Eliminated race conditions in URL duplicate detection
*   Enhanced error handling prevents server crashes during automation
*   Resolved 502 errors with proper timeout handling

**🚀 New Features:**
*   Manual automation trigger for immediate testing without waiting for schedule
*   Database integrity checker with comprehensive duplicate detection and cleanup
*   Enhanced Twitter posting with multi-candidate generation and duplicate handling
*   Improved admin panel with real-time status updates and detailed feedback

**📊 Performance Optimizations:**
*   Pagination system overcomes Supabase 1000-row limitations
*   Reduced API timeouts optimized for Railway's execution limits
*   Enhanced AI creativity with higher temperature settings for diverse content
*   Smart URL resolution handles redirects and shortened links

## 11. Future Considerations

*   **UI for Search Query Management:** Allow admins to add/edit/delete search queries
*   **Image Cropping/Editing:** Basic tools to adjust AI-generated image variants
*   **Enhanced Analytics:** Detailed metrics on automation performance and article engagement
*   **Multi-language Support:** Expand search queries and AI processing for international sources

## 12. RAG Documents System & Research Library

**Current Implementation:**
The RAG (Retrieval-Augmented Generation) documents system provides a comprehensive document management and research library functionality for storing, processing, and displaying research documents.

### Database Schema

**Core Tables:**
- **`rag_documents`**: Main documents table storing document metadata, content, and access controls
- **`rag_document_chunks`**: Individual text chunks with embeddings for semantic search
- **`ai_usage_logs`**: Tracks AI API usage for document processing

**Key Features:**
- **Access Control**: Documents can be set to `public` (visible in Research Library) or `admin` (admin-only)
- **File Storage**: Documents stored in Supabase Storage with public URLs
- **Embeddings**: OpenAI text-embedding-3-small for semantic search capabilities
- **Chunking**: Automatic text chunking for better search performance

### Document Upload Process

**Admin Panel Upload:**
1. **File Upload**: Supports PDF, DOCX, TXT files via admin interface
2. **Content Extraction**: Automatic text extraction from uploaded files
3. **Storage**: Files uploaded to Supabase Storage bucket
4. **Database Entry**: Document metadata stored in `rag_documents` table
5. **Chunking**: Content automatically split into searchable chunks
6. **Embeddings**: OpenAI embeddings generated for semantic search
7. **Access Level**: Defaults to `public` for Research Library visibility

**Manual Entry:**
- Direct text input via admin interface
- No file upload required
- Same processing pipeline as file uploads

### Research Library Frontend

**Public Access:**
- **Document Display**: Shows all documents with `access_level: 'public'`
- **Search Functionality**: Text-based search with highlighting
- **Document Viewer**: Dedicated page for reading full documents
- **PDF Support**: Built-in PDF viewer for PDF documents
- **Metadata Display**: Shows author, date, source information

**Key Endpoints:**
- `GET /api/rag-documents/public` - Fetch public documents for Research Library
- `GET /api/rag-documents/public/search` - Search public documents
- `GET /api/rag-documents/public/:id` - Get specific document details
- `POST /api/admin/rag-documents/upload` - Upload new documents (admin only)

### Document Processing Pipeline

**File Processing:**
1. **Validation**: File type and size validation
2. **Content Extraction**: 
   - PDF: Uses pdf-parse library
   - DOCX: Uses mammoth library
   - TXT: Direct text processing
3. **Storage Upload**: File uploaded to Supabase Storage
4. **Database Storage**: Metadata and content stored in PostgreSQL
5. **Chunking**: Content split into ~500-word chunks
6. **Embedding Generation**: OpenAI embeddings for each chunk
7. **Indexing**: Chunks stored in `rag_document_chunks` table

**Error Handling:**
- File validation errors return clear messages
- Processing failures logged with details
- Partial failures don't corrupt existing data

### Access Control System

**Access Levels:**
- **`public`**: Visible in Research Library, accessible to all users
- **`admin`**: Admin-only access, not visible in Research Library

**Default Behavior:**
- New uploads default to `public` access level
- Admin can change access level via dropdown in upload interface
- Research Library only displays `public` documents

### Future Enhancements (Planned)

**AI Chat Integration:**
- RAG-powered chat system using document embeddings
- Semantic search across document chunks
- Context-aware responses based on uploaded research

**Advanced Features:**
- Document categorization and tagging
- Advanced search filters
- Document versioning
- Collaborative editing capabilities

## 13. Email Processing System

**Current Implementation (Railway Deployment):**
The email processing system now runs reliably on Railway with persistent storage and proper UID tracking:

**✅ Resolved Issues:**
*   **Persistent UID Storage**: Uses Supabase database instead of ephemeral `processed.json`
*   **Smart Duplicate Prevention**: Client-side filtering prevents reprocessing of already-seen emails
*   **Proper UID Advancement**: Ensures `last_email_check_uid` updates correctly after processing
*   **Railway Compatibility**: No more serverless filesystem limitations

**How It Works:**
1. **Daily Schedule**: Runs automatically at 2:00 AM UTC as part of automation suite
2. **Manual Trigger**: Available via admin panel for immediate testing
3. **UID Tracking**: Maintains `last_email_check_uid` in Supabase for reliable progress tracking
4. **Duplicate Protection**: Multiple layers prevent reprocessing and database duplicates

---

## 🎯 Current Production Status

**\u2705 System Status: FULLY OPERATIONAL**

The MicroPlastics Pulse backend is now a robust, production-ready system with:

*   **\u2705 Reliable Daily Automation**: Runs every day at 2:00 AM UTC without gaps
*   **\u2705 Comprehensive Error Handling**: Individual task failures don't crash the system
*   **\u2705 Advanced Admin Tools**: Manual triggers, database integrity checks, real-time monitoring
*   **\u2705 Scalable Architecture**: Railway deployment with persistent processes
*   **\u2705 Database Integrity**: Automated duplicate detection and cleanup tools
*   **\u2705 Enhanced AI Integration**: Multi-candidate generation with smart duplicate handling

**Recent Success**: Automation suite completed successfully with final status: SUCCESS

**Next Scheduled Run**: Daily at 2:00 AM UTC  
**Manual Testing**: Available via admin panel automation triggers  
**Monitoring**: Railway logs + admin panel status updates

---

## 🔧 Troubleshooting Common Issues

### "Changes Not Reflecting in Production"

**Problem**: You made changes but they're not showing up on Railway.

**Solution**: Remember the dual index.js structure!
1. ✅ Did you update `api/index.js`? (Railway runs this)
2. ✅ Did you commit and push your changes?
3. ✅ Check Railway deployment logs for errors

**Quick Fix**: Always make changes in `api/index.js` first, then copy to root `index.js` for local testing.

### "Local Development Not Working"

**Problem**: `npm run dev` fails or doesn't start the server.

**Solution**: Use `npm start` instead - the backend doesn't have a `dev` script, it uses `start` which runs root `index.js`.

### "API Endpoints Not Found"

**Problem**: Getting 404 errors for API endpoints.

**Solution**: Check that your changes are in `api/index.js` and that Railway has redeployed successfully.

### "Documents Not Showing in Research Library"

**Problem**: Uploaded documents don't appear in the Research Library.

**Solution**: Check the document's access level:
1. ✅ Verify `access_level` is set to `'public'` in database
2. ✅ Check `is_active` is `true` in database
3. ✅ Ensure document was uploaded successfully (check `rag_documents` table)
4. ✅ Refresh the Research Library page

**Quick Fix**: Update access level in database:
```sql
UPDATE rag_documents SET access_level = 'public' WHERE title = 'Your Document Title';
```

### "Document Upload Fails"

**Problem**: File upload returns error or fails to process.

**Solution**: Check common issues:
1. ✅ File size within limits (check file size validation)
2. ✅ Supported file type (PDF, DOCX, TXT only)
3. ✅ Supabase Storage bucket permissions
4. ✅ OpenAI API key valid and has credits
5. ✅ Database connection working

**Debug Steps**: Check Railway logs for specific error messages during upload process.

---

This README provides a comprehensive overview of the MicroPlastics Pulse Project backend system. 