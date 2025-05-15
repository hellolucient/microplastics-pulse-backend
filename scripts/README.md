# MicroPlasticsWatch Admin Scripts

This directory contains utility scripts for administrative tasks.

## Batch Update Stories Script

The `batch-update-stories.js` script helps refresh all stories in the database with improved AI summaries and AI images.

### Purpose

When new stories are added to the database, the system automatically generates an AI summary and an AI-generated image. This script allows you to:

1. Refresh previously added stories with improved AI summaries and images
2. Process stories in small batches (default: 2 stories at a time) to avoid API rate limits
3. Start with the oldest stories and work forward chronologically
4. Take a 5-minute pause between batches to avoid overloading the APIs

### Usage

```bash
# Run from the project root directory
node scripts/batch-update-stories.js [batch_size]
```

Where:
- `batch_size` (optional): Number of stories to process per batch (default: 2)

### How It Works

1. The script calls the `/api/batch-update-stories` endpoint repeatedly
2. It processes stories in small batches starting with the oldest first
3. It updates both the AI summary and the image for each story
4. It waits 2 seconds between processing each story
5. It pauses for 5 minutes between batches to avoid rate limits
6. If errors occur, you can resume from the last processed ID

### Example

```bash
# Process 2 stories per batch (default)
node scripts/batch-update-stories.js

# Explicitly set batch size to 3 stories
node scripts/batch-update-stories.js 3
```

### Output

The script provides detailed output for each story being processed:
- ✅ Success: Shows which fields were updated (ai_summary, ai_image_url)
- ℹ️ Info: When no updates were applied
- ❌ Error: When an error occurred

### Web Interface

You can also perform batch updates through the admin web interface at `/admin`. This provides a user-friendly way to:
1. Process small batches of stories
2. View detailed results for each story
3. Continue from a specific point using the continue token

## Troubleshooting

- If the script still encounters timeouts, try reducing the batch size to 1
- For API rate limit errors, increase the delay between batches
- If you need to stop the script, note the last continue token to resume later
- Check the server logs for more detailed error messages 