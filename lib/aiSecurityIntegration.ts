/**
 * AI SECURITY INTEGRATION HOOK
 * Ready-to-use integration function for chat requests
 *
 * Usage:
 * ```typescript
 * import { assessAndSecureChatRequest } from '@/lib/aiSecurityIntegration';
 *
 * const result = await assessAndSecureChatRequest(
 *   userMessage,
 *   { userId, requestId, ip },
 *   { maxInputLength: 8000 }
 * );
 *
 * if (!result.allowed) {
 *   return NextResponse.json(result.errorResponse, { status: result.statusCode });
 * }
 *
 * // Use result.sanitizedInput for AI request
 * ```
 */

import { getAISecurityLayer, AIRequestSecurityContext, SecurityLayerConfig, SecurityAssessmentResult } from './aiSecurityLayer';
import { getRequestAuditor, SECURITY_EVENTS } from './requestAuditor';
import { createSecureError, getHttpStatus, formatSecureErrorResponse } from './secureErrorHandler';
import logger from './logger';
import { getRateLimitClientKey } from './requestMetadata';

export interface ChatSecurityCheckResult {
  allowed: boolean;
  sanitizedInput: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  assessment: SecurityAssessmentResult['assessment'];
  warnings: string[];
  errorResponse?: Record<string, unknown>;
  statusCode?: number;
  requestId: string;
  processingTimeMs: number;
}

/**
 * Main integration function: Assess and secure chat request
 *
 * This function orchestrates the complete security assessment:
 * 1. Validates input format and length
 * 2. Sanitizes for HTML/scripts/control chars
 * 3. Detects prompt injection
 * 4. Scores for abuse
 * 5. Generates audit log
 * 6. Returns safe response
 */
export async function assessAndSecureChatRequest(
  userInput: string,
  context: {
    userId: string;
    requestId: string;
    ip: string;
    conversationId?: string;
    hasImage?: boolean;
  },
  config?: Partial<SecurityLayerConfig>
): Promise<ChatSecurityCheckResult> {
  const startTime = Date.now();
  const securityLayer = getAISecurityLayer(config);
  const auditor = getRequestAuditor();

  const securityContext: AIRequestSecurityContext = {
    userId: context.userId,
    requestId: context.requestId,
    ip: context.ip,
    timestamp: Date.now(),
    conversationId: context.conversationId,
    hasImage: context.hasImage,
  };

  try {
    // Perform security assessment
    const assessment = await securityLayer.assessRequest(userInput, securityContext, config);

    const processingTime = Date.now() - startTime;

    // Log the assessment result
    auditor.logSecurityEvent(
      assessment.allowRequest ? SECURITY_EVENTS.REQUEST_ALLOWED : SECURITY_EVENTS.REQUEST_DENIED,
      securityContext,
      {
        riskLevel: assessment.riskLevel,
        injectionScore: assessment.assessment.injectionDetection.score,
        abuseScore: assessment.assessment.abuseScore.score,
        warnings: assessment.warnings,
        inputLength: userInput.length,
        sanitizedLength: assessment.sanitizedInput.length,
        processingTimeMs: processingTime,
      },
      {
        status: assessment.allowRequest ? 'success' : 'blocked',
        riskLevel: assessment.riskLevel,
        duration: processingTime,
      }
    );

    if (assessment.allowRequest) {
      return {
        allowed: true,
        sanitizedInput: assessment.sanitizedInput,
        riskLevel: assessment.riskLevel,
        assessment: assessment.assessment,
        warnings: assessment.warnings,
        requestId: context.requestId,
        processingTimeMs: processingTime,
      };
    }

    // Request denied
    const statusCode = assessment.riskLevel === 'critical' ? 403 : 400;
    const errorResponse = formatSecureErrorResponse(
      createSecureError(
        assessment.riskLevel === 'critical' ? 'abuse_detected' : 'injection_detected',
        securityContext,
        { userMessage: assessment.secureError }
      )
    );

    return {
      allowed: false,
      sanitizedInput: '',
      riskLevel: assessment.riskLevel,
      assessment: assessment.assessment,
      warnings: assessment.warnings,
      errorResponse,
      statusCode,
      requestId: context.requestId,
      processingTimeMs: processingTime,
    };
  } catch (error) {
    const processingTime = Date.now() - startTime;

    logger.error('Chat security assessment error', {
      error,
      requestId: context.requestId,
      userId: context.userId,
    });

    auditor.logSecurityEvent(
      SECURITY_EVENTS.SYSTEM_ERROR,
      securityContext,
      { error: String(error) },
      {
        status: 'error',
        riskLevel: 'high',
        duration: processingTime,
      }
    );

    // Fail secure: deny on error
    const errorResponse = formatSecureErrorResponse(
      createSecureError('server_error', securityContext)
    );

    return {
      allowed: false,
      sanitizedInput: '',
      riskLevel: 'critical',
      assessment: {
        validation: { valid: false, error: 'Assessment error' },
        injectionDetection: { hasInjection: false, score: 0, patterns: [] },
        abuseScore: {
          score: 0,
          reasons: [],
          isSuspicious: false,
          breakdown: { spamScore: 0, toxicityScore: 0, injectionScore: 0, anomalyScore: 0 },
        },
      },
      warnings: ['Security assessment encountered an error'],
      errorResponse,
      statusCode: 500,
      requestId: context.requestId,
      processingTimeMs: processingTime,
    };
  }
}

/**
 * Quick security check (returns boolean)
 * Use for simple allow/deny decisions
 */
export async function isRequestSecure(
  userInput: string,
  context: { userId: string; requestId: string; ip: string }
): Promise<boolean> {
  const result = await assessAndSecureChatRequest(userInput, { ...context });
  return result.allowed;
}

/**
 * Get security summary for metrics/monitoring
 */
export function getSecurityMetrics(result: ChatSecurityCheckResult): Record<string, unknown> {
  return {
    requestId: result.requestId,
    allowed: result.allowed,
    riskLevel: result.riskLevel,
    injectionDetected: result.assessment.injectionDetection.hasInjection,
    injectionScore: result.assessment.injectionDetection.score,
    abuseScore: result.assessment.abuseScore.score,
    warningCount: result.warnings.length,
    processingTimeMs: result.processingTimeMs,
  };
}

/**
 * Middleware wrapper for Express/Next.js
 *
 * Usage in route handler:
 * ```typescript
 * export async function POST(req: NextRequest) {
 *   const securityCheck = await createSecurityCheckMiddleware(req);
 *   if (!securityCheck.passed) {
 *     return NextResponse.json(securityCheck.error, { status: securityCheck.statusCode });
 *   }
 *
 *   // Use securityCheck.sanitizedInput
 * }
 * ```
 */
export async function createSecurityCheckMiddleware(
  request: Request & { json: () => Promise<Record<string, unknown>> }
): Promise<{
  passed: boolean;
  sanitizedInput?: string;
  error?: Record<string, unknown>;
  statusCode?: number;
  requestId?: string;
}> {
  try {
    const body = await request.json();
    const userInput = typeof body?.message === 'string' ? body.message : '';

    if (!userInput) {
      return {
        passed: false,
        error: { error: 'Message is required' },
        statusCode: 400,
      };
    }

    // Extract context from request
    const userId = body?.userId || request.headers.get('x-user-id') || 'anonymous';
    const requestId = body?.requestId || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ip = getRateLimitClientKey(request.headers);

    const result = await assessAndSecureChatRequest(userInput, { userId, requestId, ip });

    return {
      passed: result.allowed,
      sanitizedInput: result.sanitizedInput,
      error: result.errorResponse,
      statusCode: result.statusCode,
      requestId: result.requestId,
    };
  } catch (error) {
    logger.error('Security middleware error', { error });
    return {
      passed: false,
      error: { error: 'Request could not be processed' },
      statusCode: 400,
    };
  }
}

/**
 * High-performance security check (cached)
 * Use for frequently accessed requests
 */
const checkCache = new Map<string, { result: ChatSecurityCheckResult; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds

export async function assessAndSecureChatRequestCached(
  userInput: string,
  context: { userId: string; requestId: string; ip: string; conversationId?: string },
  config?: Partial<SecurityLayerConfig>
): Promise<ChatSecurityCheckResult> {
  const cacheKey = `${context.userId}:${userInput.slice(0, 50)}`;
  const cached = checkCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  const result = await assessAndSecureChatRequest(userInput, context, config);

  checkCache.set(cacheKey, { result, timestamp: Date.now() });

  // Cleanup old cache entries
  if (checkCache.size > 1000) {
    const oldestKey = Array.from(checkCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
    checkCache.delete(oldestKey);
  }

  return result;
}

export default assessAndSecureChatRequest;
