const { TwitterApi } = require('twitter-api-v2');
const fetch = require('node-fetch');

// Initialize the client with your environment variables
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

/**
 * Posts a single tweet to X.
 * @param {string} text The text content of the tweet.
 * @param {string} [imageUrl] (Optional) A URL to an image to attach to the tweet.
 * @returns {Promise<{success: boolean, tweet?: any, error?: string}>}
 */
async function postSingleTweet(text, imageUrl) {
  try {
    let mediaId;

    // If an image URL is provided, download it and upload it to Twitter
    if (imageUrl && imageUrl.startsWith('http')) {
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
      }
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      mediaId = await client.v1.uploadMedia(buffer, {
        mimeType: imageResponse.headers.get('content-type') || 'image/jpeg',
      });
    }

    // Post the tweet, including the media ID if an image was uploaded
    const tweet = await client.v2.tweet({
      text,
      ...(mediaId && { media: { media_ids: [mediaId] } }),
    });

    console.log('Tweet posted successfully:', tweet);
    return { success: true, tweet };
  } catch (error) {
    console.error('Error in postSingleTweet function:', error);
    // Check if it's an API response error with a 403 status code
    if (error.code === 403) {
        // This is a Forbidden error, likely due to duplicate content.
        const detailedMessage = 'Request failed with code 403 (Forbidden). This usually means the tweet content is a duplicate of a recent post.';
        return { success: false, error: detailedMessage };
    }
    // For other errors, use the existing generic error message logic
    const errorMessage = error.data?.detail || error.message || 'An unknown error occurred during tweet posting.';
    return { success: false, error: errorMessage };
  }
}

/**
 * Fetches the next tweet candidate and posts it with duplicate handling.
 * This is designed to be called by an automated scheduler.
 * @returns {Promise<{success: boolean, message: string, storyId?: string}>}
 */
async function postTweetForNextCandidate() {
  const { createClient } = require('@supabase/supabase-js');
  const { generateTweetPreview } = require('./coreLogic'); // Can't be at top level due to circular dependencies
  
  // This is a temporary, scoped Supabase client to avoid circular dependency issues.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // 1. Fetch multiple candidate stories (not just oldest) to provide variety
    const { data: candidates, error: fetchError } = await supabase
      .from('latest_news')
      .select('*')
      .eq('is_posted_to_twitter', false)
      .order('published_date', { ascending: true })
      .limit(5); // Get 5 candidates instead of 1

    if (fetchError) {
      throw fetchError;
    }

    if (!candidates || candidates.length === 0) {
      return { success: false, message: 'No new stories available to tweet.' };
    }

    console.log(`[Twitter] Found ${candidates.length} tweet candidates. Trying each until success...`);

    // 2. Try each candidate until we find one that posts successfully
    for (let i = 0; i < candidates.length; i++) {
      const story = candidates[i];
      console.log(`[Twitter] Attempting candidate ${i + 1}/${candidates.length}: Story ID ${story.id}`);

      try {
        // Generate tweet content with higher creativity for variety
        const tweetText = await generateTweetPreview(story);
        if (!tweetText || tweetText.includes("Could not generate")) {
          console.log(`[Twitter] Failed to generate tweet for story ${story.id}, trying next candidate`);
          continue;
        }

        console.log(`[Twitter] Generated tweet: "${tweetText.substring(0, 100)}..."`);

        // Attempt to post the tweet
        const postResult = await postSingleTweet(tweetText, story.ai_image_url);
        
        if (postResult.success) {
          // Success! Mark as posted and return
          const { error: updateError } = await supabase
            .from('latest_news')
            .update({ is_posted_to_twitter: true })
            .eq('id', story.id);

          if (updateError) {
            console.error(`[Twitter] CRITICAL: Tweet posted for story ${story.id} but DB update failed!`, updateError);
            // Continue anyway since tweet was successful
          }

          console.log(`[Twitter] Successfully posted tweet for story ${story.id}`);
          return { success: true, message: `Tweet posted successfully for story ${story.id}`, storyId: story.id };

        } else if (postResult.error && postResult.error.includes('403')) {
          // Duplicate content error - try next candidate
          console.log(`[Twitter] Story ${story.id} rejected as duplicate, trying next candidate...`);
          continue;

        } else {
          // Other error - try next candidate
          console.log(`[Twitter] Story ${story.id} failed with error: ${postResult.error}, trying next candidate...`);
          continue;
        }

      } catch (candidateError) {
        console.error(`[Twitter] Error processing candidate ${story.id}:`, candidateError);
        continue; // Try next candidate
      }
    }

    // If we get here, all candidates failed
    return { 
      success: false, 
      message: `All ${candidates.length} tweet candidates failed. Most likely due to duplicate content detection.` 
    };

  } catch (error) {
    console.error('[Twitter] Critical error in postTweetForNextCandidate:', error);
    return { success: false, message: `Critical error: ${error.message}` };
  }
}

// Note: The postTweetThread function has been removed as it was unused and for simplicity with the new library.
// It can be re-implemented if needed.

module.exports = {
  postSingleTweet,
  postTweetForNextCandidate,
}; 