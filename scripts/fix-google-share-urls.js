#!/usr/bin/env node

/**
 * Script to fix existing Google Share URLs in the latest_news table
 * This script extracts real URLs from Google Share links and updates the database
 * WITHOUT running through AI processing or image generation
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Extract real URL from Google Share link
 * @param {string} googleShareUrl - The Google Share URL
 * @returns {Promise<string|null>} - The real URL or null if extraction fails
 */
async function extractRealUrlFromGoogleShare(googleShareUrl) {
  try {
    // Handle different types of Google Share URLs
    if (googleShareUrl.includes('google.com/share') || googleShareUrl.includes('google.com/url')) {
      // Try to extract the real URL from Google Share links
      const urlMatch = googleShareUrl.match(/[?&]url=([^&]+)/);
      if (urlMatch) {
        return decodeURIComponent(urlMatch[1]);
      }
    }
    
    // Handle share.google redirect URLs (like https://share.google/rnHushzVMeoPAguSi)
    if (googleShareUrl.includes('share.google/')) {
      try {
        console.log(`   🔄 Following redirect for: ${googleShareUrl}`);
        const response = await axios.head(googleShareUrl, { 
          timeout: 10000, 
          maxRedirects: 10,
          validateStatus: function (status) {
            return status >= 200 && status < 400; // Accept redirects
          }
        });
        
        // Get the final redirected URL
        const finalUrl = response.request.res.responseUrl || 
                        response.request._redirectable?._currentUrl || 
                        response.headers.location;
        
        if (finalUrl && finalUrl !== googleShareUrl) {
          console.log(`   ✅ Redirect successful: ${finalUrl}`);
          return finalUrl;
        }
      } catch (redirectError) {
        console.warn(`   ⚠️  Redirect failed: ${redirectError.message}`);
      }
    }
    
    // If it's not a Google Share URL or extraction failed, return null
    return null;
  } catch (error) {
    console.warn(`Failed to extract real URL from: ${googleShareUrl}`, error.message);
    return null;
  }
}

/**
 * Check if a URL is a Google Share URL
 * @param {string} url - The URL to check
 * @returns {boolean} - True if it's a Google Share URL
 */
function isGoogleShareUrl(url) {
  return url.includes('google.com/share') || url.includes('google.com/url');
}

/**
 * Main function to fix Google Share URLs
 */
async function fixGoogleShareUrls() {
  console.log('🔧 Starting Google Share URL fix script...');
  
  try {
    // 1. Fetch all articles with Google Share URLs
    console.log('📥 Fetching articles with Google Share URLs...');
    const { data: articles, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, url, title')
      .or('url.like.*google.com/share*,url.like.*google.com/url*,url.like.*share.google*');

    if (fetchError) {
      throw new Error(`Failed to fetch articles: ${fetchError.message}`);
    }

    if (!articles || articles.length === 0) {
      console.log('✅ No articles with Google Share URLs found. Database is clean!');
      return;
    }

    console.log(`📊 Found ${articles.length} articles with Google Share URLs`);

    // 2. Process each article
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const article of articles) {
      try {
        console.log(`\n🔍 Processing: ${article.title.substring(0, 60)}...`);
        console.log(`   Current URL: ${article.url}`);

        // Extract real URL
        const realUrl = await extractRealUrlFromGoogleShare(article.url);
        
        if (!realUrl) {
          console.log(`   ⚠️  Could not extract real URL, skipping...`);
          skippedCount++;
          continue;
        }

        console.log(`   ✅ Extracted real URL: ${realUrl}`);

        // Update the database
        const { error: updateError } = await supabase
          .from('latest_news')
          .update({ 
            url: realUrl,
            source: new URL(realUrl).hostname // Update source to match new URL
          })
          .eq('id', article.id);

        if (updateError) {
          console.error(`   ❌ Failed to update article ${article.id}:`, updateError.message);
          errorCount++;
        } else {
          console.log(`   ✅ Successfully updated article ${article.id}`);
          updatedCount++;
        }

        // Small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`   ❌ Error processing article ${article.id}:`, error.message);
        errorCount++;
      }
    }

    // 3. Summary
    console.log('\n📋 Summary:');
    console.log(`   ✅ Updated: ${updatedCount} articles`);
    console.log(`   ⚠️  Skipped: ${skippedCount} articles (could not extract real URL)`);
    console.log(`   ❌ Errors: ${errorCount} articles`);
    console.log(`   📊 Total processed: ${articles.length} articles`);

    if (updatedCount > 0) {
      console.log('\n🎉 Successfully fixed Google Share URLs!');
      console.log('   The frontend should now show correct source domains instead of "google.com"');
    }

  } catch (error) {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  }
}

/**
 * Dry run mode - shows what would be updated without making changes
 */
async function dryRun() {
  console.log('🔍 DRY RUN MODE - No changes will be made to the database');
  console.log('   Run without --dry-run flag to actually update the database\n');
  
  try {
    const { data: articles, error: fetchError } = await supabase
      .from('latest_news')
      .select('id, url, title')
      .or('url.like.*google.com/share*,url.like.*google.com/url*,url.like.*share.google*');

    if (fetchError) {
      throw new Error(`Failed to fetch articles: ${fetchError.message}`);
    }

    if (!articles || articles.length === 0) {
      console.log('✅ No articles with Google Share URLs found. Database is clean!');
      return;
    }

    console.log(`📊 Found ${articles.length} articles with Google Share URLs:`);
    
    for (const article of articles) {
      const realUrl = await extractRealUrlFromGoogleShare(article.url);
      console.log(`\n📰 ${article.title.substring(0, 60)}...`);
      console.log(`   Current: ${article.url}`);
      console.log(`   Would update to: ${realUrl || 'COULD NOT EXTRACT'}`);
    }

    console.log(`\n🔍 DRY RUN COMPLETE - ${articles.length} articles would be updated`);

  } catch (error) {
    console.error('💥 Dry run failed:', error.message);
    process.exit(1);
  }
}

// Main execution
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  
  if (isDryRun) {
    await dryRun();
  } else {
    await fixGoogleShareUrls();
  }
  
  console.log('\n🏁 Script completed');
  process.exit(0);
}

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = {
  fixGoogleShareUrls,
  extractRealUrlFromGoogleShare,
  isGoogleShareUrl
};
