const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');

/**
 * Document Processing Pipeline
 * Handles PDF, Word, and text file extraction with chunking and metadata extraction
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
      
      let extractedData;
      
      // Extract content based on file type
      if (fileExtension === '.pdf' || mimeType === 'application/pdf') {
        extractedData = await this.extractPDFContent(fileBuffer);
      } else if (fileExtension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        extractedData = await this.extractWordContent(fileBuffer);
      } else if (fileExtension === '.doc' || mimeType === 'application/msword') {
        extractedData = await this.extractWordContent(fileBuffer);
      } else if (fileExtension === '.txt' || mimeType === 'text/plain') {
        extractedData = await this.extractTextContent(fileBuffer);
      } else {
        throw new Error(`Unsupported file type: ${fileExtension}`);
      }

      // Clean and process the extracted text
      const cleanedText = this.cleanText(extractedData.text);
      
      // Extract metadata
      const metadata = this.extractMetadata(extractedData, baseName, filename);
      
      // Create chunks for better semantic search
      const chunks = this.createChunks(cleanedText);
      
      return {
        title: metadata.title || baseName,
        content: cleanedText,
        chunks: chunks,
        metadata: metadata,
        fileType: this.getFileType(fileExtension),
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
   * Extract content from PDF
   */
  async extractPDFContent(fileBuffer) {
    try {
      const pdfData = await pdfParse(fileBuffer);
      return {
        text: pdfData.text,
        metadata: {
          pages: pdfData.numpages,
          info: pdfData.info || {}
        }
      };
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract content from Word documents
   */
  async extractWordContent(fileBuffer) {
    try {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return {
        text: result.value,
        metadata: {
          messages: result.messages || []
        }
      };
    } catch (error) {
      throw new Error(`Word document extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract content from text files
   */
  async extractTextContent(fileBuffer) {
    try {
      const text = fileBuffer.toString('utf8');
      return {
        text: text,
        metadata: {}
      };
    } catch (error) {
      throw new Error(`Text extraction failed: ${error.message}`);
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
    const typeMap = {
      '.pdf': 'pdf',
      '.docx': 'docx',
      '.doc': 'doc',
      '.txt': 'txt'
    };
    return typeMap[extension] || 'unknown';
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
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain'
    ];
    
    const allowedExtensions = ['.pdf', '.docx', '.doc', '.txt'];
    const fileExtension = path.extname(filename).toLowerCase();
    
    if (fileBuffer.length > maxSize) {
      throw new Error('File size exceeds 10MB limit');
    }
    
    if (!allowedTypes.includes(mimeType) && !allowedExtensions.includes(fileExtension)) {
      throw new Error('Unsupported file type');
    }
    
    return true;
  }
}

module.exports = DocumentProcessor;
