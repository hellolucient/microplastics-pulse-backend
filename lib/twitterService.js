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

// Note: The postTweetThread function has been removed as it was unused and for simplicity with the new library.
// It can be re-implemented if needed.

module.exports = {
  postSingleTweet,
}; 