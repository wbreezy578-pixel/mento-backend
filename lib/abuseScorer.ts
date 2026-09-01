/**
 * ABUSE SCORER
 * Detects patterns indicating abuse, spam, or malicious intent
 *
 * This module scores:
 * - Spam patterns (repetition, flooding)
 * - Harassment/toxicity indicators
 * - Profanity and hate speech
 * - Rate-limit abuse patterns
 * - Bulk/flood attempts
 * - Suspicious content distribution
 */

import { PromptInjectionResult } from './promptInjectionDetector';

export interface AbuseScoreResult {
  score: number; // 0-100
  reasons: string[];
  isSuspicious: boolean;
  breakdown: {
    spamScore: number;
    toxicityScore: number;
    injectionScore: number;
    anomalyScore: number;
  };
}

/**
 * Spam pattern detection
 */
const SPAM_PATTERNS = {
  // Excessive repetition
  repetitionRegex: /([\w\s])\1{20,}/, // Same char/word 20+ times
  excessiveCapitals: /[A-Z]{30,}/, // 30+ capital letters
  urlFlood: /https?:\/\/\S+/gi, // Multiple URLs
  
  // Common spam keywords
  spamKeywords: [
    'click here', 'buy now', 'limited time', 'act now', 'call now',
    'free money', 'earn money', 'work from home', 'guaranteed',
    'viagra', 'casino', 'lottery', 'prize', 'congratulations you won',
  ],
  
  // Number substitution (spam obfuscation)
  numberSubstitution: /[0-9]{5,}/,
};

/**
 * Toxicity indicators
 */
const TOXICITY_PATTERNS = {
  // Profanity (basic list - extend as needed)
  profanity: /\b(shit|damn|hell|crap|fuck|ass|bastard|bitch)\b/gi,
  
  // Slurs and hate speech (example patterns - be comprehensive)
  hateSpeech: /\b(slur patterns here)\b/gi,
  
  // Harassment patterns
  harassment: [
    /kill.*yourself/i,
    /you.*deserve.*die/i,
    /i'll.*find.*you/i,
    /i.*know.*where.*you.*live/i,
    /threatening\s+(violence|harm)/i,
  ],
  
  // Doxing indicators
  doxing: [
    /address.*zip.*code/i,
    /phone.*number.*email/i,
    /social.*security.*number/i,
  ],
};

/**
 * Anomaly patterns indicating unusual behavior
 */
const ANOMALY_PATTERNS = {
  // Sudden language changes
  mixedLanguages: /[\u0400-\u04FF]|[\u0600-\u06FF]|[\uAC00-\uD7AF]/,
  
  // Excessive punctuation
  excessivePunctuation: /[!?]{5,}|\.{5,}/,
  
  // Suspicious Unicode (RTL, zero-width, etc.)
  suspiciousUnicode: /[\u202E\u202D\u202C\u200B\u200C\u200D]/,
  
  // Command-like patterns
  commandLike: /^(system|admin|root|execute|eval|run)[\s:]/i,
};

/**
 * Score abuse risk in user input
 */
export function scoreAbuse(
  input: string,
  injectionResult: PromptInjectionResult
): AbuseScoreResult {
  let totalScore = 0;
  const reasons: string[] = [];
  
  const breakdown = {
    spamScore: 0,
    toxicityScore: 0,
    injectionScore: 0,
    anomalyScore: 0,
  };

  // 1. Spam detection
  const spamScore = detectSpam(input);
  if (spamScore > 0) {
    breakdown.spamScore = spamScore;
    totalScore += spamScore * 0.25;
    if (spamScore > 50) reasons.push('Spam pattern detected');
  }

  // 2. Toxicity detection
  const toxicityScore = detectToxicity(input);
  if (toxicityScore > 0) {
    breakdown.toxicityScore = toxicityScore;
    totalScore += toxicityScore * 0.35;
    if (toxicityScore > 40) reasons.push('Toxic content detected');
  }

  // 3. Injection risk (now riskScore, not score)
  breakdown.injectionScore = Math.min(100, injectionResult.riskScore || 0);
  // Weight obfuscation risk separately (Unicode/control char attacks)
  const obfuscationComponent = (injectionResult.obfuscationRisk || 0) * 0.3;
  const injectionComponent = (injectionResult.riskScore || 0) * 0.2;
  totalScore += obfuscationComponent + injectionComponent;

  if (injectionResult.blockingRecommended && injectionResult.riskScore > 60) {
    reasons.push('High-confidence injection attempt');
  } else if (injectionResult.hasInjection && injectionResult.riskScore > 50) {
    reasons.push('Potential injection signal detected');
  }

  // 4. Anomaly detection
  const anomalyScore = detectAnomalies(input);
  if (anomalyScore > 0) {
    breakdown.anomalyScore = anomalyScore;
    totalScore += anomalyScore * 0.15;
    if (anomalyScore > 60) reasons.push('Suspicious pattern detected');
  }

  // Cap at 100
  totalScore = Math.min(100, totalScore);

  return {
    score: Math.round(totalScore),
    reasons: Array.from(new Set(reasons)),
    isSuspicious: totalScore > 50,
    breakdown,
  };
}

/**
 * Detect spam patterns in input
 */
function detectSpam(input: string): number {
  let spamScore = 0;

  // Check for character repetition
  if (SPAM_PATTERNS.repetitionRegex.test(input)) {
    spamScore += 30;
  }

  // Check for excessive capitals
  const capitalCount = (input.match(/[A-Z]/g) || []).length;
  if (capitalCount > input.length * 0.3) {
    spamScore += 20;
  }

  // Check for URL flooding
  const urls = input.match(SPAM_PATTERNS.urlFlood) || [];
  if (urls.length > 3) {
    spamScore += 25 * Math.min(urls.length, 5);
  }

  // Check for spam keywords
  let spamKeywordCount = 0;
  for (const keyword of SPAM_PATTERNS.spamKeywords) {
    if (new RegExp(keyword, 'i').test(input)) {
      spamKeywordCount++;
    }
  }
  if (spamKeywordCount > 2) {
    spamScore += 30;
  }

  // Check for number substitution (spam obfuscation)
  if (SPAM_PATTERNS.numberSubstitution.test(input)) {
    spamScore += 15;
  }

  // Check for excessive line breaks or formatting
  const lineBreaks = (input.match(/\n\n+/g) || []).length;
  if (lineBreaks > 5) {
    spamScore += 20;
  }

  return Math.min(100, spamScore);
}

/**
 * Detect toxicity in input
 */
function detectToxicity(input: string): number {
  let toxicityScore = 0;

  // Check for profanity
  const profanityMatches = input.match(TOXICITY_PATTERNS.profanity) || [];
  if (profanityMatches.length > 0) {
    toxicityScore += 20 * profanityMatches.length;
  }

  // Check for harassment patterns
  for (const pattern of TOXICITY_PATTERNS.harassment) {
    if (pattern.test(input)) {
      toxicityScore += 40;
    }
  }

  // Check for doxing indicators
  for (const pattern of TOXICITY_PATTERNS.doxing) {
    if (pattern.test(input)) {
      toxicityScore += 35;
    }
  }

  // Threat detection (basic)
  if (/\b(kill|murder|rape|assault|attack)\s+(you|me|him|her|them)\b/i.test(input)) {
    toxicityScore += 50;
  }

  // Discriminatory language (basic)
  if (/\b(racist|sexist|homophobic|transphobic)\b/i.test(input) && /\b(i\s+am|we\s+are|support)\b/i.test(input)) {
    toxicityScore += 45;
  }

  return Math.min(100, toxicityScore);
}

/**
 * Detect anomalous patterns
 */
function detectAnomalies(input: string): number {
  let anomalyScore = 0;

  // Suspicious Unicode usage
  if (ANOMALY_PATTERNS.suspiciousUnicode.test(input)) {
    anomalyScore += 25;
  }

  // Excessive punctuation
  if (ANOMALY_PATTERNS.excessivePunctuation.test(input)) {
    anomalyScore += 15;
  }

  // Command-like patterns
  if (ANOMALY_PATTERNS.commandLike.test(input)) {
    anomalyScore += 30;
  }

  // Very short input with special characters (potential attack)
  if (input.length < 20 && /[^\w\s]/.test(input)) {
    // Special chars in very short input
    const specialCharRatio = (input.match(/[^\w\s]/g) || []).length / input.length;
    if (specialCharRatio > 0.3) {
      anomalyScore += 20;
    }
  }

  // Encoded/obfuscated content indicators
  if (/(%[\dA-F]{2}|\\x[\dA-F]{2}|\\u[\dA-F]{4})/i.test(input)) {
    anomalyScore += 25;
  }

  // Extremely long without meaningful structure
  if (input.length > 5000 && !/[.!?]\s/.test(input)) {
    anomalyScore += 20;
  }

  // Multiple encoding attempts
  const encodingPatterns = (input.match(/(base64|hex|rot13|unicode|ascii|utf|encode|decode|escape)/gi) || []).length;
  if (encodingPatterns > 3) {
    anomalyScore += 30;
  }

  return Math.min(100, anomalyScore);
}

/**
 * Get detailed abuse report for logging
 */
export function getAbuseReport(input: string, injectionResult: PromptInjectionResult): Record<string, unknown> {
  const result = scoreAbuse(input, injectionResult);

  return {
    abuseScore: result.score,
    isSuspicious: result.isSuspicious,
    reasons: result.reasons,
    spamScore: result.breakdown.spamScore,
    toxicityScore: result.breakdown.toxicityScore,
    injectionScore: result.breakdown.injectionScore,
    anomalyScore: result.breakdown.anomalyScore,
    riskLevel: result.score > 75 ? 'critical' : result.score > 50 ? 'high' : 'low',
  };
}

/**
 * Get sanitized version of input for safe logging
 */
export function getSanitizedInputForLogging(input: string, maxLength: number = 200): string {
  let sanitized = input
    .replace(TOXICITY_PATTERNS.profanity, '[redacted]')
    .slice(0, maxLength);
  
  if (input.length > maxLength) {
    sanitized += '...';
  }

  return sanitized;
}
