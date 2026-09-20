import { Buffer } from 'buffer';

export const MAX_LEARN_PDF_BYTES = 8 * 1024 * 1024;

export function validateLearnPdf(buffer: Buffer, declaredMimeType: unknown) {
  if (typeof declaredMimeType !== 'string' || declaredMimeType.trim().toLowerCase() !== 'application/pdf') {
    throw new Error('Unsupported learning document type.');
  }
  if (!buffer.length || buffer.length > MAX_LEARN_PDF_BYTES) {
    throw new Error('The PDF is invalid or too large.');
  }
  // PDFs always begin with this header. Do not trust an extension or MIME type.
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('The selected file is not a valid PDF.');
  }
  return { mimeType: 'application/pdf' as const, buffer };
}
