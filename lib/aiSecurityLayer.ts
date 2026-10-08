/**
 * AI REQUEST SECURITY LAYER
 * Production-grade security service for all AI chat requests
 *
 * This module provides:
 * - Input validation and sanitization
 * - Unicode normalization and control character stripping
 * - HTML/Script sanitization
 * - Prompt injection detection
 * - Abuse scoring and pattern detection
 * - Secure request logging (no API keys/secrets)
 * - Structured error responses
 * - Privacy preservation
 *
 * Security principles:
 * 1. Never expose API keys, tokens, or internal prompts
 * 2. Fail securely with safe error messages
 * 3. Log security events for monitoring
 * 4. Preserve user privacy
 * 5. Defense in depth with multiple validation layers
 */

import logger from './logger';
import { sanitizeForLogging } from './sanitize';
import { detectPromptInjection, PromptInjectionResult } from './promptInjectionDetector';
import { scoreAbuse, AbuseScoreResult } from './abuseScorer';

/**
 * Security context for a single AI request
 */
export interface AIRequestSecurityContext {
  userId: string;
  requestId: string;
  ip: string;
  timestamp: number;
  conversationId?: string;
  hasImage?: boolean;
}

/**
 * Input validation result
 */
export interface ValidationResult {
  valid: boolean;
  sanitized?: string;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Complete security assessment result
 */
export interface SecurityAssessmentResult {
  safe: boolean;
  sanitizedInput: string;
  assessment: {
    validation: ValidationResult;
    injectionDetection: PromptInjectionResult;
    abuseScore: AbuseScoreResult;
  };
  warnings: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  allowRequest: boolean;
  secureError?: string;
}

/**
 * Configuration for security layer
 */
export interface SecurityLayerConfig {
  maxInputLength?: number;
  maxUnicodeNormalizationRuns?: number;
  enablePromptInjectionDetection?: boolean;
  enableAbuseScoring?: boolean;
  enableDetailedLogging?: boolean;
  abuseScoreThreshold?: number; // 0-100
  logSecurityEvents?: boolean;
}

// Default configuration
const DEFAULT_CONFIG: SecurityLayerConfig = {
  maxInputLength: 8000,
  maxUnicodeNormalizationRuns: 3,
  enablePromptInjectionDetection: true,
  enableAbuseScoring: true,
  enableDetailedLogging: process.env.NODE_ENV !== 'production',
  abuseScoreThreshold: 70,
  logSecurityEvents: true,
};

class AISecurityLayer {
  private config: SecurityLayerConfig;

  constructor(config: Partial<SecurityLayerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main entry point: Assess and secure an AI request
   */
  async assessRequest(
    input: string,
    context: AIRequestSecurityContext,
    config?: Partial<SecurityLayerConfig>
  ): Promise<SecurityAssessmentResult> {
    const startTime = Date.now();
    const effectiveConfig = { ...this.config, ...config };

    try {
      // Step 1: Validate input format and length
      const validation = this.validateInput(input, effectiveConfig);
      if (!validation.valid) {
        const error = validation.error || 'Invalid input';
        this.logSecurityEvent('validation_failed', context, { error, details: validation.details });
        return this.createSecureErrorResponse(
          false,
          'Input validation failed',
          'low',
          error
        );
      }

      // Step 2: Sanitize input (Unicode, control chars, HTML)
      const sanitized = this.sanitizeInput(validation.sanitized || input);

      // Step 3: Prompt injection detection
      let injectionResult: PromptInjectionResult = {
        hasInjection: false,
        riskScore: 0,
        obfuscationRisk: 0,
        patterns: [],
        blockingRecommended: false,
        detectionDetails: {
          normalized: false,
          scriptTypes: [],
          detectedLanguage: 'unknown',
          characterAnomalies: [],
        },
      };
      if (effectiveConfig.enablePromptInjectionDetection) {
        injectionResult = detectPromptInjection(sanitized);
        if (injectionResult.hasInjection) {
          // Log detection for telemetry/monitoring (not automatic blocking)
          this.logSecurityEvent('injection_signal_detected', context, {
            riskScore: injectionResult.riskScore,
            obfuscationRisk: injectionResult.obfuscationRisk,
            blockingRecommended: injectionResult.blockingRecommended,
            patterns: injectionResult.patterns.map((p) => ({ type: p.type, severity: p.severity })),
            language: injectionResult.detectionDetails.detectedLanguage,
          });
        }
      }

      // Step 4: Abuse scoring
      let abuseScoreResult: AbuseScoreResult = {
        score: 0,
        reasons: [],
        isSuspicious: false,
        breakdown: { spamScore: 0, toxicityScore: 0, injectionScore: 0, anomalyScore: 0 },
      };
      if (effectiveConfig.enableAbuseScoring) {
        abuseScoreResult = scoreAbuse(sanitized, injectionResult);
        if (abuseScoreResult.score >= (effectiveConfig.abuseScoreThreshold || 70)) {
          this.logSecurityEvent('abuse_score_high', context, {
            score: abuseScoreResult.score,
            reasons: abuseScoreResult.reasons,
          });
        }
      }

      // Step 5: Determine risk level and allow/deny decision
      const riskLevel = this.calculateRiskLevel(injectionResult, abuseScoreResult, sanitized);
      // CHANGED: Only block if blockingRecommended from detector + high abuse score
      // Never block solely on regex keyword matching
      const allowRequest = riskLevel !== 'critical' &&
        !(injectionResult.blockingRecommended && abuseScoreResult.score >= 70);

      const warnings: string[] = [];
      if (injectionResult.blockingRecommended) warnings.push('High-confidence prompt injection pattern detected');
      if (abuseScoreResult.isSuspicious) warnings.push(`Suspicious content pattern (abuse score: ${abuseScoreResult.score})`);

      const duration = Date.now() - startTime;

      if (allowRequest) {
        this.logSecurityEvent('request_allowed', context, {
          riskLevel,
          injectionScore: injectionResult.riskScore,
          abuseScore: abuseScoreResult.score,
          processingTimeMs: duration,
        });
      } else {
        this.logSecurityEvent('request_denied', context, {
          riskLevel,
          injectionScore: injectionResult.riskScore,
          abuseScore: abuseScoreResult.score,
          processingTimeMs: duration,
        });
      }

      return {
        safe: allowRequest,
        sanitizedInput: sanitized,
        assessment: {
          validation,
          injectionDetection: injectionResult,
          abuseScore: abuseScoreResult,
        },
        warnings,
        riskLevel,
        allowRequest,
      };
    } catch (error) {
      logger.error('AI security layer error', { error, context });
      this.logSecurityEvent('security_layer_error', context, { error: String(error) });
      // Fail securely: deny on internal error
      return this.createSecureErrorResponse(
        false,
        'Security assessment failed',
        'critical',
        'An error occurred while processing your request'
      );
    }
  }

  /**
   * Validate input format and length
   */
  private validateInput(input: string, config: SecurityLayerConfig): ValidationResult {
    if (typeof input !== 'string') {
      return {
        valid: false,
        error: 'Input must be a string',
        details: { type: typeof input },
      };
    }

    const trimmed = input.trim();

    if (!trimmed) {
      return {
        valid: false,
        error: 'Input cannot be empty',
      };
    }

    if (trimmed.length > (config.maxInputLength || 8000)) {
      return {
        valid: false,
        error: `Input exceeds maximum length of ${config.maxInputLength}`,
        details: { length: trimmed.length, maxLength: config.maxInputLength },
      };
    }

    return {
      valid: true,
      sanitized: trimmed,
    };
  }

  /**
   * Comprehensive input sanitization
   */
  private sanitizeInput(input: string): string {
    let sanitized = input;

    // 1. Unicode normalization (NFC - canonical decomposition followed by canonical composition)
    try {
      sanitized = sanitized.normalize('NFC');
    } catch (e) {
      logger.warn('Unicode normalization failed', { error: String(e) });
    }

    // 2. Strip control characters (keep: tab, newline, carriage return)
    sanitized = this.stripControlCharacters(sanitized);

    // 3. Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');

    // 4. HTML/Script tag sanitization
    sanitized = this.sanitizeHtmlAndScripts(sanitized);

    // 5. Collapse excessive whitespace
    sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

    return sanitized;
  }

  /**
   * Strip control characters while preserving meaningful whitespace
   */
  private stripControlCharacters(text: string): string {
    // Remove: NUL, SOH-BS, VT, FF, SO-US (except TAB=09, LF=0A, CR=0D)
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  /**
   * Sanitize HTML and script content
   */
  private sanitizeHtmlAndScripts(text: string): string {
    let sanitized = text;

    // Remove script tags and content
    sanitized = sanitized.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '[removed script]');
    sanitized = sanitized.replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '[removed iframe]');
    sanitized = sanitized.replace(/<embed[\s\S]*?>/gi, '[removed embed]');
    sanitized = sanitized.replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, '[removed object]');

    // Strip javascript: and data: URIs
    sanitized = sanitized.replace(/javascript:/gi, '');
    sanitized = sanitized.replace(/data:text\/html/gi, '');

    // Remove event handlers
    sanitized = sanitized.replace(/on\w+\s*=/gi, '');

    return sanitized;
  }

  /**
   * Calculate overall risk level
   * NOTE: Injection detection is now a signal, not proof.
   * High-confidence injection + abuse score together determine blocking.
   */
  private calculateRiskLevel(
    injection: PromptInjectionResult,
    abuse: AbuseScoreResult,
    input: string
  ): 'low' | 'medium' | 'high' | 'critical' {
    let riskScore = 0;

    // Injection risk (now called riskScore, not score)
    if (injection.riskScore > 80) riskScore += 30;
    else if (injection.riskScore > 60) riskScore += 20;
    else if (injection.riskScore > 40) riskScore += 10;

    // Obfuscation risk (Unicode/control char attacks)
    if (injection.obfuscationRisk > 75) riskScore += 35;
    else if (injection.obfuscationRisk > 50) riskScore += 20;
    else if (injection.obfuscationRisk > 25) riskScore += 10;

    // Abuse score
    if (abuse.score > 85) riskScore += 40;
    else if (abuse.score > 70) riskScore += 25;
    else if (abuse.score > 50) riskScore += 10;

    // Input characteristics
    if (input.length > 5000) riskScore += 5;
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(input)) riskScore += 15; // Control chars after sanitization = anomaly

    // Critical indicators (direct manipulation syntax)
    if (/^(repeat|ignore|override|execute|system:|admin:|root:)/i.test(input)) riskScore += 20;

    if (riskScore >= 80) return 'critical';
    if (riskScore >= 60) return 'high';
    if (riskScore >= 30) return 'medium';
    return 'low';
  }

  /**
   * Create secure error response (never expose details)
   */
  private createSecureErrorResponse(
    safe: boolean,
    reason: string,
    riskLevel: 'low' | 'medium' | 'high' | 'critical',
    userMessage: string
  ): SecurityAssessmentResult {
    return {
      safe,
      sanitizedInput: '',
      assessment: {
        validation: { valid: false, error: reason },
        injectionDetection: { hasInjection: false, riskScore: 0, obfuscationRisk: 0, patterns: [], blockingRecommended: false, detectionDetails: { normalized: false, scriptTypes: [], detectedLanguage: 'unknown', characterAnomalies: [] } },
        abuseScore: {
          score: 0,
          reasons: [],
          isSuspicious: false,
          breakdown: { spamScore: 0, toxicityScore: 0, injectionScore: 0, anomalyScore: 0 },
        },
      },
      warnings: [reason],
      riskLevel,
      allowRequest: false,
      secureError: userMessage,
    };
  }

  /**
   * Log security events (with secrets redacted)
   */
  private logSecurityEvent(
    eventType: string,
    context: AIRequestSecurityContext,
    details: Record<string, unknown> = {}
  ): void {
    if (!this.config.logSecurityEvents) return;

    const sanitizedDetails = sanitizeForLogging(details);
    logger.info(`[SECURITY] ${eventType}`, {
      userId: context.userId,
      requestId: context.requestId,
      ip: context.ip,
      timestamp: new Date(context.timestamp).toISOString(),
      conversationId: context.conversationId,
      ...sanitizedDetails,
    });
  }

  /**
   * Get security summary for monitoring/metrics
   */
  getSecuritySummary(result: SecurityAssessmentResult): Record<string, unknown> {
    return {
      allowed: result.allowRequest,
      riskLevel: result.riskLevel,
      injectionScore: result.assessment.injectionDetection.riskScore,
      abuseScore: result.assessment.abuseScore.score,
      warnings: result.warnings.length,
      sanitizedLength: result.sanitizedInput.length,
    };
  }
}

// Singleton instance
let securityLayerInstance: AISecurityLayer | null = null;

/**
 * Get or create security layer instance
 */
export function getAISecurityLayer(config?: Partial<SecurityLayerConfig>): AISecurityLayer {
  if (!securityLayerInstance) {
    securityLayerInstance = new AISecurityLayer(config);
  }
  return securityLayerInstance;
}

export default getAISecurityLayer();
