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
    const errorMessage = error.data?.detail || error.message || 'An unknown error occurred during tweet posting.';
    return { success: false, error: errorMessage };
  }
}

/**
 * Fetches the next tweet candidate (oldest un-posted story) and posts it.
 * This is designed to be called by an automated scheduler.
 * @returns {Promise<{success: boolean, message: string, storyId?: string}>}
 */
async function postTweetForNextCandidate() {
  const { createClient } = require('@supabase/supabase-js');
  const { generateTweetPreview } = require('./coreLogic'); // Can't be at top level due to circular dependencies
  
  // This is a temporary, scoped Supabase client to avoid circular dependency issues.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // 1. Fetch the oldest story that hasn't been posted to Twitter.
    const { data: story, error: fetchError } = await supabase
      .from('latest_news')
      .select('*')
      .eq('is_posted_to_twitter', false)
      .order('published_date', { ascending: true })
      .limit(1)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return { success: false, message: 'No new stories available to tweet.' };
      }
      throw fetchError;
    }

    if (!story) {
      return { success: false, message: 'No new stories available to tweet.' };
    }

    // 2. Generate the tweet content for this story.
    const tweetText = await generateTweetPreview(story);
    if (!tweetText || tweetText.includes("Could not generate")) {
      throw new Error(`Failed to generate tweet preview for story ${story.id}`);
    }

    // 3. Post the tweet.
    const postResult = await postSingleTweet(tweetText, story.ai_image_url);
    if (!postResult.success) {
      throw new Error(postResult.error);
    }

    // 4. Mark the story as posted in the database.
    const { error: updateError } = await supabase
      .from('latest_news')
      .update({ is_posted_to_twitter: true })
      .eq('id', story.id);

    if (updateError) {
      // The tweet was posted, but we failed to mark it. This is a critical log.
      console.error(`CRITICAL: Tweet for story ${story.id} was posted, but DB flag update failed!`, updateError);
      // Even with the DB error, the primary action succeeded.
      return { success: true, message: 'Tweet posted, but failed to update DB status.', storyId: story.id };
    }

    return { success: true, message: 'Tweet posted successfully.', storyId: story.id };

  } catch (error) {
    console.error('Error in postTweetForNextCandidate:', error.message);
    return { success: false, message: error.message };
  }
}

// Note: The postTweetThread function has been removed as it was unused and for simplicity with the new library.
// It can be re-implemented if needed.

module.exports = {
  postSingleTweet,
  postTweetForNextCandidate,
}; 