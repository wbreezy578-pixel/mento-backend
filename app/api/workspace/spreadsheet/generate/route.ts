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
import logger from '../../../../../lib/logger';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../../lib/userSettings';
import { parseGeneratedWorkspaceSpreadsheet, toLegacyWorkspaceSpreadsheet } from '../../../../../services/workspaceSpreadsheet';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_BODY_BYTES = 16 * 1024;
const WORKSPACE_GENERATION_OPTIONS = { responseMimeType: 'application/json', maxOutputTokens: 8192 } as const;

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
            parts: [{ text: `${buildTutorLanguageInstruction(language)}\nCreate a useful spreadsheet for the user's request. Return only valid JSON with this shape: {"title":"...","columns":[{"name":"...","kind":"text|number|currency|percent|date"}],"rows":[[literal cell values]],"formulas":[{"cell":"C2","formula":"=A2*B2"}]}. Use 2 to 8 columns and 3 to 75 rows, with one value per column in every row. Values must be strings, finite numbers, or null. Put requested formulas only in the formulas array, use A1 cell references and the supported functions SUM, AVERAGE, MIN, and MAX, and leave formula cells null in rows. Include every formula the user requests, including totals or averages, and ensure each formula target is within the returned rows and columns. For percentages, use kind "number" when the formula multiplies by 100; use kind "percent" only for fractional 0-to-1 values. Return formulas as an empty array when none are requested. Do not wrap JSON in markdown or include explanatory text.` }],
          },
          { role: 'user', parts: [{ text: sanitizedInput ?? prompt }] },
        ];
        const model = billingDecision.modelUsed ?? undefined;
        const response = await askGemini(contents, model, reportUsage, reportProviderAttempt, req.signal, WORKSPACE_GENERATION_OPTIONS);
        try {
          return parseGeneratedWorkspaceSpreadsheet(response, sanitizedInput ?? prompt);
        } catch {
          const repairedResponse = await askGemini([
            ...contents,
            { role: 'model', parts: [{ text: response }] },
            { role: 'user', parts: [{ text: 'The previous response did not match the required JSON workbook format. Return a corrected complete JSON object only. Preserve the requested rows and formulas.' }] },
          ], model, reportUsage, reportProviderAttempt, req.signal, WORKSPACE_GENERATION_OPTIONS);
          return parseGeneratedWorkspaceSpreadsheet(repairedResponse, sanitizedInput ?? prompt);
        }
      },
    });

    return NextResponse.json({ workbook: result, spreadsheet: toLegacyWorkspaceSpreadsheet(result) }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    const gatewayError = error instanceof AIRequestGatewayError ? error : null;
    logger.error('Workspace spreadsheet generation failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      gatewayStatus: gatewayError?.status,
    });
    const message = gatewayError && gatewayError.body && typeof gatewayError.body === 'object' && 'error' in gatewayError.body
      ? String((gatewayError.body as { error?: unknown }).error ?? 'Spreadsheet generation is unavailable.')
      : 'Spreadsheet generation is unavailable. Please try again shortly.';
    return NextResponse.json(
      { error: message },
      { status: gatewayError?.status ?? 500, headers: buildCorsHeaders(req.headers.get('origin')) },
    );
  }
}