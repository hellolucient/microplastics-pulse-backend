# MicroPlasticsWatch Admin Scripts

This directory contains utility scripts for administrative tasks.

## Batch Update Stories Script

The `batch-update-stories.js` script helps refresh all stories in the database with improved AI summaries and AI images.

### Purpose

When new stories are added to the database, the system automatically generates an AI summary and an AI-generated image. This script allows you to:

1. Refresh previously added stories with improved AI summaries and images
2. Process stories in batches to avoid API rate limits
3. Start with the oldest stories and work forward chronologically

### Usage

```bash
# Run from the project root directory
node scripts/batch-update-stories.js [batch_size]
```

Where:
- `batch_size` (optional): Number of stories to process per batch (default: 5)

### How It Works

1. The script calls the `/api/batch-update-stories` endpoint repeatedly
2. It processes stories in batches starting with the oldest first
3. It updates both the AI summary and the image for each story
4. If errors occur, you can resume from the last processed ID
5. Each batch waits 5 seconds before starting the next batch to avoid rate limits

### Example

```bash
# Process 10 stories per batch
node scripts/batch-update-stories.js 10
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

- If the script fails due to API rate limits, reduce the batch size
- If you need to stop the script, note the last continue token to resume later
- Check the server logs for more detailed error messages 