import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  enforceAIGatewayRateLimit: vi.fn(),
  executeAIRequest: vi.fn(),
  getClientIp: vi.fn(),
  requireClientAIRequestId: vi.fn(),
  secureAITextInput: vi.fn(),
  askGemini: vi.fn(),
  getTutorLanguage: vi.fn(),
  buildTutorLanguageInstruction: vi.fn(),
  parseGeneratedWorkspaceSpreadsheet: vi.fn(),
  loggerError: vi.fn(),
  validateWorkspaceWorkbook: vi.fn(),
  buildWorkspaceWorkbookXlsx: vi.fn(),
  createWorkspaceWorkbookFromLegacySpreadsheet: vi.fn(),
  toLegacyWorkspaceSpreadsheet: vi.fn(),
  isSupportedWorkspaceFormulaSource: vi.fn(),
}));

vi.mock('../../../../lib/aiSecurityGateway', () => ({
  AIRequestGatewayError: class AIRequestGatewayError extends Error {
    status = 500;
    body: unknown = null;
    headers = {};
  },
  authenticateAIRequest: mocks.authenticateAIRequest,
  enforceAIGatewayRateLimit: mocks.enforceAIGatewayRateLimit,
  executeAIRequest: mocks.executeAIRequest,
  getClientIp: mocks.getClientIp,
  requireClientAIRequestId: mocks.requireClientAIRequestId,
  secureAITextInput: mocks.secureAITextInput,
}));

vi.mock('../../../../services/geminiService', () => ({
  GeminiSafetyBlockedError: class GeminiSafetyBlockedError extends Error {
    code = 'safety_blocked';
  },
  askGemini: mocks.askGemini,
}));

vi.mock('../../../../lib/userSettings', () => ({
  buildTutorLanguageInstruction: mocks.buildTutorLanguageInstruction,
  getTutorLanguage: mocks.getTutorLanguage,
}));

vi.mock('../../../../lib/logger', () => ({
  default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../../services/workspaceSpreadsheet', () => ({
  parseGeneratedWorkspaceSpreadsheet: mocks.parseGeneratedWorkspaceSpreadsheet,
  validateWorkspaceWorkbook: mocks.validateWorkspaceWorkbook,
  buildWorkspaceWorkbookXlsx: mocks.buildWorkspaceWorkbookXlsx,
  createWorkspaceWorkbookFromLegacySpreadsheet: mocks.createWorkspaceWorkbookFromLegacySpreadsheet,
  toLegacyWorkspaceSpreadsheet: mocks.toLegacyWorkspaceSpreadsheet,
  isSupportedWorkspaceFormulaSource: mocks.isSupportedWorkspaceFormulaSource,
}));

import { POST as generateSpreadsheet } from './generate/route';
import { POST as exportSpreadsheet } from './export/route';
import { POST as suggestFormula } from './suggest-formula/route';

const workbook = {
  schemaVersion: 2,
  id: 'workbook-1',
  title: 'Monthly Budget',
  sheets: [{
    id: 'sheet-1',
    name: 'Monthly Budget',
    columns: [{ id: 'column-1', name: 'Category', kind: 'text' }, { id: 'column-2', name: 'Budget', kind: 'currency' }],
    rows: [{ id: 'row-1', cells: [{ type: 'value', value: 'Housing' }, { type: 'value', value: 1500 }] }],
  }],
};
const legacySpreadsheet = {
  title: 'Monthly Budget',
  columns: [{ name: 'Category', kind: 'text' }, { name: 'Budget', kind: 'currency' }],
  rows: [['Housing', 1500]],
};

function postRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Workspace spreadsheet billing contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateAIRequest.mockResolvedValue({ id: 'user-1' });
    mocks.enforceAIGatewayRateLimit.mockResolvedValue(undefined);
    mocks.getClientIp.mockReturnValue('127.0.0.1');
    mocks.requireClientAIRequestId.mockImplementation((_request: Request, requestId: string) => requestId);
    mocks.secureAITextInput.mockResolvedValue({ sanitizedInput: 'make a budget' });
    mocks.executeAIRequest.mockResolvedValue({ result: workbook });
    mocks.validateWorkspaceWorkbook.mockReturnValue(workbook);
    mocks.buildWorkspaceWorkbookXlsx.mockResolvedValue(Buffer.from('xlsx-content'));
    mocks.createWorkspaceWorkbookFromLegacySpreadsheet.mockReturnValue(workbook);
    mocks.toLegacyWorkspaceSpreadsheet.mockReturnValue(legacySpreadsheet);
    mocks.isSupportedWorkspaceFormulaSource.mockReturnValue(true);
  });

  it('reserves one spreadsheet allowance for each spreadsheet generation', async () => {
    const response = await generateSpreadsheet(postRequest('https://mento.test/api/workspace/spreadsheet/generate', {
      prompt: 'make a budget',
      requestId: 'workspace-request-1234',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workbook, spreadsheet: legacySpreadsheet });
    expect(mocks.executeAIRequest).toHaveBeenCalledTimes(1);
    expect(mocks.executeAIRequest).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'spreadsheet',
      amount: 1,
      provider: 'Gemini',
      metadata: expect.objectContaining({ source: 'workspace', operationType: 'workspace.spreadsheet.generate' }),
    }));
  });

  it('logs unexpected generation failures without logging the spreadsheet prompt', async () => {
    const prompt = 'private quarterly forecast prompt';
    mocks.executeAIRequest.mockRejectedValueOnce(new Error('provider response could not be parsed'));
    const response = await generateSpreadsheet(postRequest('https://mento.test/api/workspace/spreadsheet/generate', {
      prompt,
      requestId: 'workspace-request-error-1234',
    }));

    expect(response.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalledWith('Workspace spreadsheet generation failed', expect.objectContaining({
      errorName: 'Error',
      errorMessage: 'provider response could not be parsed',
    }));
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(prompt);
  });

  it('requests structured JSON and retries malformed output within one spreadsheet reservation', async () => {
    const generated = {
      title: 'Sales',
      columns: [
        { name: 'Units', kind: 'number' },
        { name: 'Price', kind: 'currency' },
        { name: 'Revenue', kind: 'currency' },
      ],
      rows: [[12, 8, null]],
      formulas: [{ cell: 'C2', formula: '=A2*B2' }],
    };
    const workbookWithFormula = {
      ...workbook,
      sheets: [{
        ...workbook.sheets[0],
        rows: [{ ...workbook.sheets[0].rows[0], cells: [
          { type: 'value', value: 'Housing' },
          { type: 'value', value: 1500 },
          { type: 'formula', formula: '=A2*B2', result: null },
        ] }],
      }],
    };
    mocks.getTutorLanguage.mockResolvedValueOnce('en');
    mocks.buildTutorLanguageInstruction.mockReturnValueOnce('Respond in English.');
    mocks.parseGeneratedWorkspaceSpreadsheet
      .mockImplementationOnce(() => { throw new Error('invalid JSON'); })
      .mockReturnValueOnce(workbookWithFormula);
    mocks.askGemini
      .mockResolvedValueOnce('Here is the workbook, but not as JSON.')
      .mockResolvedValueOnce(JSON.stringify(generated));
    mocks.executeAIRequest.mockImplementationOnce(async (options: {
      callback: (context: {
        billingDecision: { modelUsed: string };
        sanitizedInput: string;
        reportUsage: () => void;
        reportProviderAttempt: () => Promise<number>;
      }) => Promise<unknown>;
    }) => ({
      result: await options.callback({
        billingDecision: { modelUsed: 'gemini-test' },
        sanitizedInput: 'Create a sales spreadsheet with revenue formulas.',
        reportUsage: vi.fn(),
        reportProviderAttempt: vi.fn().mockResolvedValue(1),
      }),
    }));

    const response = await generateSpreadsheet(postRequest('https://mento.test/api/workspace/spreadsheet/generate', {
      prompt: 'Create a sales spreadsheet with revenue formulas.',
      requestId: 'workspace-request-json-1234',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workbook.sheets[0].rows[0].cells[2]).toEqual({ type: 'formula', formula: '=A2*B2', result: null });
    expect(mocks.askGemini).toHaveBeenCalledTimes(2);
    expect(mocks.askGemini.mock.calls[0][5]).toEqual({ responseMimeType: 'application/json', maxOutputTokens: 8192 });
    expect(mocks.askGemini.mock.calls[0][0][0].parts[0].text).toContain('For percentages, use kind "number" when the formula multiplies by 100');
    expect(mocks.executeAIRequest).toHaveBeenCalledTimes(1);
  });

  it('exports the edited sheet without reserving another AI usage unit', async () => {
    const response = await exportSpreadsheet(postRequest('https://mento.test/api/workspace/spreadsheet/export', { workbook }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('xlsx-content'));
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
    expect(mocks.askGemini).not.toHaveBeenCalled();
  });

  it('routes formula suggestions through the authenticated billed AI gateway with structure-only context', async () => {
    mocks.getTutorLanguage.mockResolvedValueOnce('en');
    mocks.buildTutorLanguageInstruction.mockReturnValueOnce('Respond in English.');
    mocks.secureAITextInput.mockImplementationOnce(({ input }: { input: string }) => Promise.resolve({ sanitizedInput: input }));
    mocks.askGemini.mockResolvedValueOnce('=SUM(B2:B3)');
    mocks.executeAIRequest.mockImplementationOnce(async (options: {
      callback: (context: {
        billingDecision: { modelUsed: string };
        sanitizedInput: string;
        reportUsage: () => void;
        reportProviderAttempt: () => Promise<number>;
      }) => Promise<unknown>;
    }) => ({
      result: await options.callback({
        billingDecision: { modelUsed: 'gemini-test' },
        sanitizedInput: JSON.stringify({ prompt: 'Add the two amounts', target: { sheetName: 'Budget', cellReference: 'C2' }, sheets: [{ name: 'Budget', columns: ['Category', 'Amount', 'Total'] }] }),
        reportUsage: vi.fn(),
        reportProviderAttempt: vi.fn().mockResolvedValue(0),
      }),
    }));
    const response = await suggestFormula(postRequest('https://mento.test/api/workspace/spreadsheet/suggest-formula', {
      prompt: 'Add the two amounts',
      requestId: 'formula-request-1234',
      target: { sheetName: 'Budget', cellReference: 'C2' },
      sheets: [{ name: 'Budget', columns: ['Category', 'Amount', 'Total'] }],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ formula: '=SUM(B2:B3)' });
    expect(mocks.authenticateAIRequest).toHaveBeenCalledTimes(1);
    expect(mocks.executeAIRequest).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'chat',
      amount: 1,
      provider: 'Gemini',
      metadata: expect.objectContaining({ source: 'workspace', operationType: 'workspace.spreadsheet.suggest_formula' }),
    }));
    expect(mocks.isSupportedWorkspaceFormulaSource).toHaveBeenCalledWith('=SUM(B2:B3)', new Set(['BUDGET']));
    const securedInput = mocks.secureAITextInput.mock.calls[0][0].input as string;
    expect(securedInput).toContain('Add the two amounts');
    expect(securedInput).toContain('Budget');
    expect(securedInput).not.toContain('1500');
    const geminiMessages = JSON.stringify(mocks.askGemini.mock.calls[0][0]);
    expect(geminiMessages).toContain('Add the two amounts');
    expect(geminiMessages).toContain('cellReference');
    expect(geminiMessages).not.toContain('1500');
  });

  it('rejects formula suggestions outside the supported formula grammar', async () => {
    mocks.executeAIRequest.mockResolvedValueOnce({ result: '=WEBSERVICE("https://example.invalid")' });
    mocks.isSupportedWorkspaceFormulaSource.mockReturnValueOnce(false);
    const response = await suggestFormula(postRequest('https://mento.test/api/workspace/spreadsheet/suggest-formula', {
      prompt: 'Fetch a value from the internet',
      requestId: 'formula-request-5678',
      target: { sheetName: 'Budget', cellReference: 'C2' },
      sheets: [{ name: 'Budget', columns: ['Category', 'Amount', 'Total'] }],
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'invalid_formula_suggestion' });
  });

  it('accepts the legacy flat export payload from existing app builds', async () => {
    mocks.validateWorkspaceWorkbook.mockReturnValue(null);
    const response = await exportSpreadsheet(postRequest('https://mento.test/api/workspace/spreadsheet/export', { spreadsheet: legacySpreadsheet }));

    expect(response.status).toBe(200);
    expect(mocks.createWorkspaceWorkbookFromLegacySpreadsheet).toHaveBeenCalledWith(legacySpreadsheet);
    expect(mocks.buildWorkspaceWorkbookXlsx).toHaveBeenCalledWith(workbook);
  });
});