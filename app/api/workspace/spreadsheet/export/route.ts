import { NextResponse } from 'next/server';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
} from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { buildWorkspaceWorkbookXlsx, createWorkspaceWorkbookFromLegacySpreadsheet, validateWorkspaceWorkbook } from '../../../../../services/workspaceSpreadsheet';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit((user as { id: string }).id, getClientIp(req));

    let body: { workbook?: unknown; spreadsheet?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: buildCorsHeaders(req.headers.get('origin')) });
    }

    const requestData = body.workbook ?? body.spreadsheet;
    const workbook = validateWorkspaceWorkbook(requestData) ?? createWorkspaceWorkbookFromLegacySpreadsheet(requestData);
    if (!workbook) {
      return NextResponse.json({ error: 'The workbook data is invalid.', code: 'invalid_workspace_workbook' }, { status: 400, headers: buildCorsHeaders(req.headers.get('origin')) });
    }

    const buffer = await buildWorkspaceWorkbookXlsx(workbook);
    const filename = workbook.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'mento_workspace';
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...buildCorsHeaders(req.headers.get('origin')),
        'Cache-Control': 'no-store, private',
        'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
  } catch (error) {
    const gatewayError = error instanceof AIRequestGatewayError ? error : null;
    const message = gatewayError?.body && typeof gatewayError.body === 'object' && 'error' in gatewayError.body
      ? String((gatewayError.body as { error?: unknown }).error ?? 'Excel export is unavailable.')
      : 'Excel export is unavailable. Please try again.';
    return NextResponse.json({ error: message }, { status: gatewayError?.status ?? 500, headers: buildCorsHeaders(req.headers.get('origin')) });
  }
}