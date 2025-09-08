require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkMissingAIContent() {
  try {
    console.log('🔍 Checking for articles missing AI Summary and/or AI Image...\n');

    // Get all articles
    const { data: allArticles, error: allError } = await supabase
      .from('latest_news')
      .select('id, title, ai_summary, ai_image_url')
      .order('created_at', { ascending: false });

    if (allError) {
      throw allError;
    }

    if (!allArticles || allArticles.length === 0) {
      console.log('❌ No articles found in database');
      return;
    }

    console.log(`📊 Total articles in database: ${allArticles.length}\n`);

    // Categorize articles
    const missingSummary = [];
    const missingImage = [];
    const missingBoth = [];
    const hasBoth = [];

    allArticles.forEach(article => {
      const hasSummary = article.ai_summary && article.ai_summary.trim() !== '';
      const hasImage = article.ai_image_url && article.ai_image_url.trim() !== '';

      if (!hasSummary && !hasImage) {
        missingBoth.push(article);
      } else if (!hasSummary) {
        missingSummary.push(article);
      } else if (!hasImage) {
        missingImage.push(article);
      } else {
        hasBoth.push(article);
      }
    });

    // Display results
    console.log('📋 SUMMARY REPORT:');
    console.log('==================');
    console.log(`✅ Articles with BOTH AI Summary AND AI Image: ${hasBoth.length}`);
    console.log(`❌ Articles missing BOTH AI Summary AND AI Image: ${missingBoth.length}`);
    console.log(`📝 Articles missing ONLY AI Summary: ${missingSummary.length}`);
    console.log(`🖼️  Articles missing ONLY AI Image: ${missingImage.length}`);
    console.log(`📊 Total articles missing at least one: ${missingBoth.length + missingSummary.length + missingImage.length}\n`);

    // Show missing both
    if (missingBoth.length > 0) {
      console.log('🚨 ARTICLES MISSING BOTH AI SUMMARY AND AI IMAGE:');
      console.log('================================================');
      missingBoth.forEach((article, index) => {
        console.log(`${index + 1}. ${article.id}`);
        console.log(`   Title: ${article.title.substring(0, 80)}${article.title.length > 80 ? '...' : ''}`);
        console.log('');
      });
    }

    // Show missing summary only
    if (missingSummary.length > 0) {
      console.log('📝 ARTICLES MISSING ONLY AI SUMMARY:');
      console.log('====================================');
      missingSummary.forEach((article, index) => {
        console.log(`${index + 1}. ${article.id}`);
        console.log(`   Title: ${article.title.substring(0, 80)}${article.title.length > 80 ? '...' : ''}`);
        console.log('');
      });
    }

    // Show missing image only
    if (missingImage.length > 0) {
      console.log('🖼️  ARTICLES MISSING ONLY AI IMAGE:');
      console.log('====================================');
      missingImage.forEach((article, index) => {
        console.log(`${index + 1}. ${article.id}`);
        console.log(`   Title: ${article.title.substring(0, 80)}${article.title.length > 80 ? '...' : ''}`);
        console.log('');
      });
    }

    // Export to JSON files for easy access
    const fs = require('fs');
    const path = require('path');

    const exportData = {
      summary: {
        total: allArticles.length,
        hasBoth: hasBoth.length,
        missingBoth: missingBoth.length,
        missingSummaryOnly: missingSummary.length,
        missingImageOnly: missingImage.length,
        totalMissing: missingBoth.length + missingSummary.length + missingImage.length
      },
      articles: {
        missingBoth: missingBoth.map(a => ({ id: a.id, title: a.title })),
        missingSummaryOnly: missingSummary.map(a => ({ id: a.id, title: a.title })),
        missingImageOnly: missingImage.map(a => ({ id: a.id, title: a.title }))
      }
    };

    const outputPath = path.join(__dirname, 'missing-ai-content-report.json');
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
    console.log(`\n💾 Detailed report saved to: ${outputPath}`);

    // Create simple UUID lists
    const uuidLists = {
      missingBoth: missingBoth.map(a => a.id),
      missingSummaryOnly: missingSummary.map(a => a.id),
      missingImageOnly: missingImage.map(a => a.id),
      missingSummary: [...missingBoth.map(a => a.id), ...missingSummary.map(a => a.id)],
      missingImage: [...missingBoth.map(a => a.id), ...missingImage.map(a => a.id)],
      missingAny: [...missingBoth.map(a => a.id), ...missingSummary.map(a => a.id), ...missingImage.map(a => a.id)]
    };

    const uuidPath = path.join(__dirname, 'missing-ai-content-uuids.json');
    fs.writeFileSync(uuidPath, JSON.stringify(uuidLists, null, 2));
    console.log(`📋 UUID lists saved to: ${uuidPath}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkMissingAIContent();
