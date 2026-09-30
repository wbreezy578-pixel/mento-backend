import { NextResponse } from 'next/server';
import { askGemini, type GeminiMessage } from '../../../../../services/geminiService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  requireClientAIRequestId,
  secureAITextInput,
} from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../../lib/userSettings';
import { parseGeneratedWorkspaceSpreadsheet, toLegacyWorkspaceSpreadsheet } from '../../../../../services/workspaceSpreadsheet';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_BODY_BYTES = 16 * 1024;

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const userId = (user as { id: string }).id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(userId, clientIp);

    let body: { prompt?: unknown; requestId?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: buildCorsHeaders(req.headers.get('origin')) });
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 12000) {
      return NextResponse.json({ error: 'Enter a spreadsheet request under 12,000 characters.', code: 'invalid_workspace_prompt' }, { status: 400, headers: buildCorsHeaders(req.headers.get('origin')) });
    }

    const requestId = requireClientAIRequestId(req, body.requestId);
    const securityDecision = await secureAITextInput({ userId, requestId, ip: clientIp, input: prompt });
    const { result } = await executeAIRequest({
      user,
      clientIp,
      feature: 'spreadsheet',
      provider: 'Gemini',
      amount: 1,
      requestId,
      metadata: { source: 'workspace', operationType: 'workspace.spreadsheet.generate' },
      securityInput: prompt,
      securityDecision,
      callback: async ({ billingDecision, sanitizedInput, reportUsage, reportProviderAttempt }) => {
        const language = await getTutorLanguage(userId);
        const contents: GeminiMessage[] = [
          {
            role: 'system',
            parts: [{ text: `${buildTutorLanguageInstruction(language)}\nCreate a useful spreadsheet for the user's request. Return only a JSON object with this exact shape: {"title":"...","columns":[{"name":"...","kind":"text|number|currency|percent|date"}],"rows":[[cell values]]}. Use 2 to 8 columns, 3 to 25 rows, and no formulas. Each row must have one value per column. Values must be strings, finite numbers, or null. Do not wrap the JSON in markdown.` }],
          },
          { role: 'user', parts: [{ text: sanitizedInput ?? prompt }] },
        ];
        const response = await askGemini(contents, billingDecision.modelUsed ?? undefined, reportUsage, reportProviderAttempt, req.signal);
        return parseGeneratedWorkspaceSpreadsheet(response);
      },
    });

    return NextResponse.json({ workbook: result, spreadsheet: toLegacyWorkspaceSpreadsheet(result) }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    const gatewayError = error instanceof AIRequestGatewayError ? error : null;
    const message = gatewayError && gatewayError.body && typeof gatewayError.body === 'object' && 'error' in gatewayError.body
      ? String((gatewayError.body as { error?: unknown }).error ?? 'Spreadsheet generation is unavailable.')
      : 'Spreadsheet generation is unavailable. Please try again shortly.';
    return NextResponse.json(
      { error: message },
      { status: gatewayError?.status ?? 500, headers: buildCorsHeaders(req.headers.get('origin')) },
    );
  }
}