/**
 * PROMPT INJECTION DETECTOR
 *
 * ⚠️ IMPORTANT SECURITY NOTE:
 * This detector is a RISK SIGNAL for telemetry and monitoring.
 * It is NOT an authoritative security boundary.
 *
 * This module identifies POTENTIAL prompt injection patterns:
 * - Role-switching instructions (ignore previous, act as, pretend)
 * - System prompt exposure attempts
 * - Constraint bypassing
 * - Encoding-based obfuscation
 * - Context boundary violations
 * - Nested instruction injection
 *
 * REAL SECURITY BOUNDARIES (independent of this detector):
 * - Trusted system instructions (never override)
 * - Untrusted user content (always sanitized)
 * - Untrusted conversation history (marked as such)
 * - Server-side authorization (enforced at gateway)
 * - Tool/provider boundaries (enforced by API design)
 * - Gemini's own safety guardrails
 *
 * Legitimate educational questions discussing security concepts
 * (e.g., "What is a system prompt?", "Explain harmful prompt injection")
 * are EXPECTED to match some patterns and should NOT be blocked
 * solely because they match regex keywords.
 *
 * Use this detector for:
 * - Risk scoring and monitoring
 * - Rate limiting high-risk accounts
 * - Alerting security teams
 * - Research and telemetry
 *
 * Do NOT use this detector for:
 * - Blocking legitimate educational requests
 * - Refusing to answer security questions
 * - Automatic request termination (without additional context)
 */

import { estimateObfuscationRisk, normalizeTextForDetection, sanitizeForLog } from '../services/textNormalizer';

export interface PromptInjectionResult {
  hasInjection: boolean;
  riskScore: number; // 0-100 (advisory signal, not proof)
  obfuscationRisk: number; // 0-100 (Unicode/control char risk)
  patterns: InjectionPattern[];
  blockingRecommended: boolean; // true only if high confidence + multiple patterns
  detectionDetails: {
    normalized: boolean;
    scriptTypes: string[];
    detectedLanguage: string;
    characterAnomalies: string[];
  };
}

export interface InjectionPattern {
  type: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string[];
  educational: boolean; // true if pattern commonly appears in legitimate educational context
}

/**
 * Pattern definitions for injection detection
 *
 * NOTE: Many legitimate educational questions will match these patterns.
 * Matching a pattern is a RISK SIGNAL, not proof of malicious intent.
 */
const INJECTION_PATTERNS = [
  // Role-switching - but exclude legitimate tutoring context
  {
    type: 'role_switch',
    patterns: [
      /^ignore\s+(all\s+)?previous\s+(instruction|prompt|message|request)/i,
      /^forget\s+(all\s+)?previous/i,
      /^disregard\s+(all\s+)?previous/i,
      // More specific: "act as" followed by non-tutor/non-assistant roles
      /\bact\s+as\s+(?!(a\s+)?(tutor|teacher|mentor|assistant|helpful|educator))/i,
      /\bpretend\s+to\s+be\s+(?!(a\s+)?(tutor|teacher|mentor|assistant))/i,
      /\byou\s+are\s+now\s+(?!(a\s+)?(tutor|teacher|mentor|assistant))/i,
      /^from\s+now\s+on\s+(ignore|forget|disregard|bypass)/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  // System prompt exposure - legitimate educational context possible
  {
    type: 'system_prompt_exposure',
    patterns: [
      /^(show|reveal|display|print|output|share)\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instruction)/i,
      /^(show|reveal|display|print|output|share)\s+(me\s+)?(your\s+)?complete\s+(system\s+)?(prompt|instructions?)/i,
      /^what\s+is\s+your\s+(system\s+)?prompt\s*\?/i,
      /^what\s+(instruction|prompt)\s+were\s+you\s+given/i,
    ],
    severity: 'high' as const,
    educational: true, // Can be legitimate AI education question
  },

  // Constraint bypassing - but be specific about actual bypass attempts
  {
    type: 'constraint_bypass',
    patterns: [
      /^(bypass|disable|remove|turn\s+off|ignore)\s+(?:all\s+|any\s+)?(?:(?:safety|security)\s+)?(restriction|filter|limit|safeguard)s?/i,
      /^(unlock|open|enable)\s+(restricted|hidden|locked)\s+(content|feature|mode)/i,
      /^jailbreak/i,
      /^(developer\s+)?mode\s+(on|enabled|activate)/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  // A compound imperative is substantially less ambiguous than a single
  // security keyword and merits a separate high-confidence signal.
  {
    type: 'compound_constraint_bypass',
    patterns: [
      /^(?:bypass|disable|remove|turn\s+off)\s+(?:all\s+|any\s+)?(?:(?:safety|security)\s+)?(?:restriction|filter|limit|safeguard)s?[\s\S]{0,240}(?:disable|bypass|remove|turn\s+off)\s+(?:all\s+|any\s+)?(?:restriction|filter|limit|safeguard)s?/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  // Nested instruction injection - code blocks
  {
    type: 'nested_injection',
    patterns: [
      /""".{1,500}(ignore|override|execute|bypass).{0,200}"""/is,
      /```[\s\S]{1,500}(ignore|override|execute|bypass)/i,
      /\[SYSTEM\]\s*:/i,
      /\[ADMIN\]\s*:/i,
      /\[ROOT\]\s*:/i,
      /\<\<SYSTEM\>\>/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  // Encoding/obfuscation attempts - but "Base64" and encoding discussions are educational
  {
    type: 'encoding_obfuscation',
    patterns: [
      /^(decode|execute)\s+(base64|ROT13|hex|unicode)/i,
      /^eval\s*\(/i,
      /^execute\s*\(/i,
    ],
    severity: 'medium' as const,
    educational: true, // Base64, encoding are legitimate topics
  },

  // Context boundary violation - specific about accessing other users
  {
    type: 'context_boundary',
    patterns: [
      /^(access|retrieve|show|get)\s+(other\s+)?users?[\s']?(.*)?prompt/i,
      /^(access|retrieve|show|get)\s+(previous\s+)?(other\s+)?conversation/i,
      /^(exfiltrate|leak|expose|dump)\s+(database|memory|cache|conversation)/i,
    ],
    severity: 'medium' as const,
    educational: false,
  },

  // Direct manipulation attempts - very specific patterns
  {
    type: 'direct_manipulation',
    patterns: [
      /^(system|admin|root|operator)\s*:\s*(?!.*\b(ignore|bypass|override|execute|disable|reveal)\b)/i,
      /^override\s*:/i,
      /^execute\s*:/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  {
    type: 'authority_override',
    patterns: [
      /^(system|admin|root|operator)\s*:\s*.*\b(ignore|bypass|override|execute|disable|reveal)\b/i,
    ],
    severity: 'high' as const,
    educational: false,
  },

  // Pseudocode injection - logical flow for injection
  {
    type: 'pseudocode_injection',
    patterns: [
      /if\s+.*then\s+.*output\s+(my\s+)?(prompt|instruction|secret)/i,
      /begin\s+(ignore|override|execute)\s+(instruction|prompt)/i,
    ],
    severity: 'medium' as const,
    educational: true, // Pseudocode in education contexts is common
  },

  // Language switching to bypass filters
  {
    type: 'language_switch',
    patterns: [
      /^(respond|answer|reply)\s+in\s+(binary|hex|morse|ascii|octal)/i,
      /^(write|encode|translate)\s+in\s+(binary|hex|morse|code)/i,
    ],
    severity: 'low' as const,
    educational: true, // Encoding discussions are educational
  },

  // Multiturn manipulation
  {
    type: 'multiturn_manipulation',
    patterns: [
      /^(for\s+all\s+)?(future|next|all\s+subsequent)\s+(requests?|responses?|prompt|message)/i,
      /^starting\s+from\s+now\s+(ignore|forget|override|bypass)/i,
    ],
    severity: 'medium' as const,
    educational: false,
  },

  // Arabic-specific injection patterns
  {
    type: 'arabic_injection',
    patterns: [
      /^تجاهل/i, // Arabic: ignore
      /^تناسى/i, // Arabic: forget
      /^تصرف/i, // Arabic: act
    ],
    severity: 'high' as const,
    educational: false,
  },

  // Swahili-specific injection patterns
  {
    type: 'swahili_injection',
    patterns: [
      /^samehe\s+/i, // Swahili: forgive/forget
      /^jinga\s+/i, // Swahili: avoid
      /^jaribu\s+kufanya/i, // Swahili: try to do
    ],
    severity: 'high' as const,
    educational: false,
  },
];

/**
 * Detect prompt injection attempts in input
 *
 * IMPORTANT: This returns a RISK SIGNAL, not an authoritative decision.
 * The caller must decide whether to block based on additional context.
 */
export function detectPromptInjection(input: string): PromptInjectionResult {
  const detectedPatterns: InjectionPattern[] = [];
  let totalRiskScore = 0;
  let educationalPatternCount = 0;

  // Normalize for detection (original content unchanged)
  const normalized = normalizeTextForDetection(input);

  for (const patternGroup of INJECTION_PATTERNS) {
    const evidence: string[] = [];

    for (const regex of patternGroup.patterns) {
      // Test against normalized text for consistency
      const matches = normalized.normalized.match(regex);
      if (matches) {
        evidence.push(...matches);
      }
    }

    if (evidence.length > 0) {
      const severityScore = {
        high: 25,
        medium: 15,
        low: 5,
      };

      const score = severityScore[patternGroup.severity];

      // Reduce score for educational patterns (they're expected to match)
      const adjustedScore = patternGroup.educational ? Math.max(score / 2, 5) : score;
      totalRiskScore += adjustedScore * evidence.length;

      if (patternGroup.educational) {
        educationalPatternCount += evidence.length;
      }

      detectedPatterns.push({
        type: patternGroup.type,
        pattern: `${patternGroup.patterns.length} patterns`,
        severity: patternGroup.severity,
        evidence: Array.from(new Set(evidence)).slice(0, 3), // Top 3 unique matches
        educational: patternGroup.educational,
      });
    }
  }

  // Cap risk score at 100
  totalRiskScore = Math.min(100, totalRiskScore);

  // Calculate obfuscation risk
  const obfuscationRisk = estimateObfuscationRisk(normalized.characteristics);

  // Blocking recommendation:
  // Only recommend blocking if:
  // 1. HIGH confidence: Multiple non-educational patterns matching
  // 2. OR: High obfuscation risk + some injection patterns
  // 3. Intentional manipulation indicators (not just keywords)
  const nonEducationalPatterns = detectedPatterns.filter(p => !p.educational);
  const explicitAuthorityOverride = nonEducationalPatterns.some((pattern) => pattern.type === 'authority_override');
  const blockingRecommended =
    explicitAuthorityOverride ||
    (nonEducationalPatterns.length >= 2 && totalRiskScore >= 60) ||
    (obfuscationRisk >= 50 && totalRiskScore >= 50) ||
    totalRiskScore >= 80;

  return {
    hasInjection: detectedPatterns.length > 0,
    riskScore: totalRiskScore,
    obfuscationRisk,
    patterns: detectedPatterns,
    blockingRecommended,
    detectionDetails: {
      normalized: normalized.normalized !== normalized.original,
      scriptTypes: Array.from(normalized.characteristics.scriptTypes),
      detectedLanguage: normalized.characteristics.detectedLanguage,
      characterAnomalies: [
        ...(normalized.characteristics.hasZeroWidthChars ? ['zero-width-chars'] : []),
        ...(normalized.characteristics.hasRTLOverride ? ['rtl-override'] : []),
        ...(normalized.characteristics.hasControlChars ? ['control-chars'] : []),
        ...(normalized.characteristics.hasExcessiveDiacritics ? ['excessive-diacritics'] : []),
      ],
    },
  };
}

/**
 * Check if input contains suspicious character patterns
 * This is now handled by normalizeTextForDetection() and estimateObfuscationRisk()
 * but kept for backward compatibility.
 */
export function hasSuspiciousCharacterPatterns(input: string): boolean {
  const normalized = normalizeTextForDetection(input);
  const risk = estimateObfuscationRisk(normalized.characteristics);

  // Treat characters removed by normalization as suspicious even when a
  // single anomaly does not cross the aggregate risk threshold. U+200C is
  // intentionally excluded because it is legitimate in several scripts.
  const hasRemovableZeroWidthCharacters = /[\u200B\u200D\u2060\uFEFF]/.test(input);
  return hasRemovableZeroWidthCharacters
    || normalized.characteristics.hasRTLOverride
    || normalized.characteristics.hasControlChars
    || normalized.characteristics.hasExcessiveDiacritics
    || risk >= 50;
}

/**
 * Analyze semantic similarity to known injection patterns
 * NOTE: This is now primarily for telemetry, not for blocking decisions.
 */
export function analyzeSemanticSimilarity(input: string, threshold: number = 0.7): number {
  // Keywords that might indicate injection attempts, but are also used in education
  const riskKeywords = [
    'ignore', 'forget', 'disregard', 'override', 'bypass', 'disable',
    'system', 'admin', 'root', 'prompt', 'instruction',
    'jailbreak', 'unlock', 'restrict', 'hidden',
  ];

  const inputTokens = input.toLowerCase().split(/\s+/);
  let matches = 0;

  for (const token of inputTokens) {
    for (const keyword of riskKeywords) {
      if (token.includes(keyword) || keyword.includes(token)) {
        matches++;
        break;
      }
    }
  }

  return matches / Math.max(inputTokens.length, 1);
}

/**
 * Get detailed injection report for logging (telemetry-safe)
 *
 * NOTE: This function does NOT include raw learner content.
 * It returns only metadata suitable for security monitoring.
 */
export function getInjectionReport(input: string): Record<string, unknown> {
  const result = detectPromptInjection(input);
  const suspicious = hasSuspiciousCharacterPatterns(input);
  const semantic = analyzeSemanticSimilarity(input);

  // NEVER expose raw input in logs
  return {
    hasInjection: result.hasInjection,
    riskScore: result.riskScore,
    obfuscationRisk: result.obfuscationRisk,
    blockingRecommended: result.blockingRecommended,
    patternCount: result.patterns.length,
    patternTypes: result.patterns.map((p) => p.type),
    educationalPatterns: result.patterns.filter(p => p.educational).length,
    suspiciousCharacters: suspicious,
    characterAnomalies: result.detectionDetails.characterAnomalies,
    semanticSimilarity: semantic,
    detectedLanguage: result.detectionDetails.detectedLanguage,
    overallRisk: result.riskScore > 70 ? 'high' : result.riskScore > 40 ? 'medium' : 'low',
    inputLength: input.length,
    inputPreview: sanitizeForLog(input), // Safe truncated version
  };
}
