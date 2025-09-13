const pdfParse = require('pdf-parse');
const pdfParsePages = require('pdf-parse-pages');
const fs = require('fs').promises;
const path = require('path');

/**
 * Document Processing Pipeline
 * Handles PDF file extraction with chunking and metadata extraction
 * Only PDF files are supported for reliable processing
 */

class DocumentProcessor {
  constructor() {
    this.maxChunkSize = 1000; // Characters per chunk
    this.chunkOverlap = 200; // Overlap between chunks
  }

  /**
   * Process uploaded document file
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} filename - Original filename
   * @param {string} mimeType - MIME type
   * @returns {Object} Processed document data
   */
  async processDocument(fileBuffer, filename, mimeType) {
    try {
      const fileExtension = path.extname(filename).toLowerCase();
      const baseName = path.basename(filename, fileExtension);
      
      // Only support PDF files
      if (fileExtension !== '.pdf' && mimeType !== 'application/pdf') {
        throw new Error(`Only PDF files are supported. Received: ${fileExtension || mimeType}`);
      }
      
      // Extract content from PDF
      const extractedData = await this.extractPDFContent(fileBuffer);

      // Clean and process the extracted text
      const cleanedText = this.cleanText(extractedData.text);
      
      // Extract metadata
      const metadata = this.extractMetadata(extractedData, baseName, filename);
      
      // Create chunks for better semantic search
      const chunks = this.createChunks(cleanedText);
      
      return {
        title: metadata.title || baseName,
        content: cleanedText,
        pages: extractedData.pages, // Store page information
        chunks: chunks,
        metadata: metadata,
        fileType: 'pdf',
        fileSize: fileBuffer.length,
        wordCount: this.countWords(cleanedText),
        chunkCount: chunks.length
      };
      
    } catch (error) {
      console.error('Error processing document:', error);
      throw new Error(`Failed to process document: ${error.message}`);
    }
  }

  /**
   * Extract content from PDF with page information
   */
  async extractPDFContent(fileBuffer) {
    try {
      // Use pdf-parse-pages for page-aware extraction
      const pdfData = await pdfParsePages(fileBuffer);
      
      // Combine all page text for full content
      const fullText = pdfData.pages.join('\n\n');
      
      return {
        text: fullText,
        pages: pdfData.pages, // Array of page texts
        metadata: {
          pages: pdfData.numpages,
          info: pdfData.info || {}
        }
      };
    } catch (error) {
      // Fallback to regular pdf-parse if pdf-parse-pages fails
      console.warn('pdf-parse-pages failed, falling back to pdf-parse:', error.message);
      const pdfData = await pdfParse(fileBuffer);
      return {
        text: pdfData.text,
        pages: null, // No page information available
        metadata: {
          pages: pdfData.numpages,
          info: pdfData.info || {}
        }
      };
    }
  }


  /**
   * Clean extracted text
   */
  cleanText(text) {
    return text
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple newlines
      .replace(/[ \t]{2,}/g, ' ') // Reduce multiple spaces
      .trim();
  }

  /**
   * Extract metadata from document
   */
  extractMetadata(extractedData, baseName, filename) {
    const metadata = {
      filename: filename,
      extractedAt: new Date().toISOString()
    };

    // Extract title from text (first line or first sentence)
    const firstLine = extractedData.text.split('\n')[0].trim();
    if (firstLine && firstLine.length > 10 && firstLine.length < 200) {
      metadata.title = firstLine;
    }

    // Extract author if available in PDF info
    if (extractedData.metadata?.info?.Author) {
      metadata.author = extractedData.metadata.info.Author;
    }

    // Extract creation date if available
    if (extractedData.metadata?.info?.CreationDate) {
      metadata.date = extractedData.metadata.info.CreationDate;
    }

    // Extract subject if available
    if (extractedData.metadata?.info?.Subject) {
      metadata.subject = extractedData.metadata.info.Subject;
    }

    return metadata;
  }

  /**
   * Create chunks for better semantic search
   */
  createChunks(text) {
    if (text.length <= this.maxChunkSize) {
      return [text];
    }

    const chunks = [];
    let start = 0;
    
    while (start < text.length) {
      let end = start + this.maxChunkSize;
      
      // Try to break at sentence boundary
      if (end < text.length) {
        const lastSentenceEnd = text.lastIndexOf('.', end);
        const lastParagraphEnd = text.lastIndexOf('\n\n', end);
        
        if (lastParagraphEnd > start + this.maxChunkSize * 0.5) {
          end = lastParagraphEnd;
        } else if (lastSentenceEnd > start + this.maxChunkSize * 0.7) {
          end = lastSentenceEnd + 1;
        }
      }
      
      const chunk = text.substring(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      
      // Move start position with overlap
      start = end - this.chunkOverlap;
      if (start >= text.length) break;
    }
    
    return chunks;
  }

  /**
   * Get file type from extension
   */
  getFileType(extension) {
    return extension === '.pdf' ? 'pdf' : 'unknown';
  }

  /**
   * Count words in text
   */
  countWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Generate embeddings for document chunks
   * @param {Array} chunks - Document chunks
   * @param {Function} generateEmbedding - Embedding generation function
   * @returns {Array} Array of embeddings
   */
  async generateChunkEmbeddings(chunks, generateEmbedding) {
    const embeddings = [];
    
    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await generateEmbedding(chunks[i]);
        embeddings.push({
          chunkIndex: i,
          text: chunks[i],
          embedding: embedding
        });
      } catch (error) {
        console.error(`Error generating embedding for chunk ${i}:`, error);
        // Continue with other chunks
      }
    }
    
    return embeddings;
  }

  /**
   * Validate file before processing
   */
  validateFile(fileBuffer, filename, mimeType) {
    const maxSize = 10 * 1024 * 1024; // 10MB
    const fileExtension = path.extname(filename).toLowerCase();
    
    if (fileBuffer.length > maxSize) {
      throw new Error('File size exceeds 10MB limit');
    }
    
    if (fileExtension !== '.pdf' && mimeType !== 'application/pdf') {
      throw new Error('Only PDF files are supported. Please convert your document to PDF before uploading.');
    }
    
    return true;
  }
}

module.exports = DocumentProcessor;
