# MicroPlastics Pulse Project

## 1. Overview

The MicroPlastics Pulse Project is a web application designed to aggregate, process, and display the latest news and research related to microplastics. It aims to provide users with a curated feed of articles, enhanced with AI-generated summaries and illustrative images, to highlight the pervasiveness and impact of microplastics on health and the environment.

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
*   **Secure Image Storage:** Utilizes Vercel Blob for reliable image hosting.
*   **Robust Database:** Employs Supabase (PostgreSQL) for structured data storage.

## 4. Project Structure

The project is organized into two main repositories, typically managed within a parent project directory:

1.  **`microplastics-pulse-frontend`**
    *   **Description:** Contains the frontend application built with React (using TypeScript and Vite).
    *   **Responsibilities:** User interface, presenting the news feed, admin dashboard interactions, and communication with the backend API.

2.  **`microplastics-pulse-backend`**
    *   **Description:** Contains the backend API built with Node.js and Express.js, designed for serverless deployment on Vercel.
    *   **Responsibilities:** API endpoints for fetching/serving news, handling article submissions, AI processing (summaries, images), database interactions (Supabase), and interfacing with Google Search and Vercel Blob.

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
    *   Vercel (for frontend and backend serverless functions)

## 6. Key Backend API Endpoints

The backend exposes several key API endpoints under the `/api` path:

*   `GET /latest-news`: Fetches the list of processed news articles for the public feed.
*   `POST /add-news`: Allows manual submission of a new article URL for processing.
*   `POST /trigger-fetch`: (Used by Admin Panel) Triggers the processing of a single search query by its index.
    *   *Note: The `GET /trigger-fetch` for a full cron-style run was found to be problematic due to serverless execution limits and is effectively deprecated in favor of the manual, step-by-step fetch from the admin panel.*
*   `POST /batch-update-stories`: Processes a batch of stories from the database. Currently configured to find stories where `ai_image_url` is NULL and regenerate both the summary and image.
*   `POST /regenerate-image`: Regenerates the AI image for a specific article identified by its UUID.
*   `GET /search-queries`: Returns the predefined list of search queries used for fetching articles.

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
    *   **Backend:** `cd microplastics-pulse-backend && npm run dev` (or your configured script, often `node api/index.js` for local testing if set up for it).
    *   **Frontend:** `cd microplastics-pulse-frontend && npm run dev` (or `yarn dev`). This will usually start the Vite development server, and you can access the frontend in your browser (typically `http://localhost:5173` or similar).

## 8. Future Considerations / Potential Improvements

*   **Cron Job Robustness:** If automated fetching is desired on Vercel, explore options like:
    *   Modifying the cron-triggered backend function to process only a small subset of queries per invocation, using a persistent store (like a Supabase table or Vercel KV) to track progress between runs.
    *   Using an external, more robust cron job service that calls a simple trigger endpoint on Vercel.
*   **UI for Search Query Management:** Allow admins to add/edit/delete search queries directly from the admin panel.
*   **Image Cropping/Editing:** Basic tools to adjust or select from multiple AI-generated image variants.
*   **Detailed Logging/Monitoring:** Enhanced logging for easier debugging of backend processes.
*   **Scalability:** For significantly higher traffic or processing loads, a move from serverless to a dedicated server (as discussed) might be necessary, requiring infrastructure management.

---

This README provides a comprehensive overview of the MicroPlastics Pulse Project. 