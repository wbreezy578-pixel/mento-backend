import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildWorkspaceWorkbookXlsx,
  parseGeneratedWorkspaceSpreadsheet,
  validateWorkspaceWorkbook,
  type WorkspaceWorkbook,
} from './workspaceSpreadsheet';

const legacyWorkbook = {
  schemaVersion: 1,
  id: 'workbook-1',
  title: 'Monthly Budget',
  sheets: [{
    id: 'sheet-1',
    name: 'Monthly Budget',
    columns: [
      { id: 'column-1', name: 'Category', kind: 'text' },
      { id: 'column-2', name: 'Budget', kind: 'currency' },
    ],
    rows: [
      { id: 'row-1', cells: ['Housing', 1500] },
      { id: 'row-2', cells: ['Utilities', 220] },
    ],
  }],
};
const validWorkbook = validateWorkspaceWorkbook(legacyWorkbook)!;

describe('workspace workbook payloads', () => {
  it('migrates a v1 literal workbook and rejects malformed IDs and cells', () => {
    expect(validWorkbook.schemaVersion).toBe(2);
    expect(validWorkbook.sheets[0].rows[0].cells[0]).toEqual({ type: 'value', value: 'Housing' });
    expect(validateWorkspaceWorkbook(legacyWorkbook)).toEqual(validWorkbook);
    expect(validateWorkspaceWorkbook({ ...validWorkbook, schemaVersion: 3 })).toBeNull();
    expect(validateWorkspaceWorkbook({ ...validWorkbook, sheets: [{ ...validWorkbook.sheets[0], rows: [{ id: 'row-1', cells: ['Housing'] }] }] })).toBeNull();
    expect(validateWorkspaceWorkbook({ ...validWorkbook, sheets: [{ ...validWorkbook.sheets[0], rows: [{ id: 'sheet-1', cells: [{ type: 'value', value: 'Housing' }, { type: 'value', value: 1500 }] }] }] })).toBeNull();
  });

  it('wraps generated sheet data in a workbook and assigns stable unique IDs', () => {
    const generated = {
      title: 'Monthly Budget',
      columns: [{ name: 'Category', kind: 'text' }, { name: 'Budget', kind: 'currency' }],
      rows: [['Housing', 1500]],
    };
    const workbook = parseGeneratedWorkspaceSpreadsheet(`\`\`\`json\n${JSON.stringify(generated)}\n\`\`\``);
    const ids = [workbook.id, workbook.sheets[0].id, ...workbook.sheets[0].columns.map((column) => column.id), ...workbook.sheets[0].rows.map((row) => row.id)];

    expect(workbook).toMatchObject({ schemaVersion: 2, title: 'Monthly Budget', sheets: [{ name: 'Monthly Budget' }] });
    expect(ids).toHaveLength(new Set(ids).size);
    expect(validateWorkspaceWorkbook(workbook)).toEqual(workbook);
  });

  it('exports every workbook sheet with typed values and styled headers', async () => {
    const workbookData: WorkspaceWorkbook = {
      ...validWorkbook,
      sheets: [
        validWorkbook.sheets[0],
        {
          id: 'sheet-2',
          name: 'Summary',
          columns: [{ id: 'column-3', name: 'Metric', kind: 'text' }, { id: 'column-4', name: 'Value', kind: 'number' }],
          rows: [
            { id: 'row-3', cells: [{ type: 'value', value: 'Count' }, { type: 'value', value: 2 }] },
            { id: 'row-4', cells: [{ type: 'value', value: 'Double' }, { type: 'formula', formula: "='Monthly Budget'!B2*2", result: 3000 }] },
          ],
        },
      ],
    };
    const buffer = await buildWorkspaceWorkbookXlsx(workbookData);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(['Monthly Budget', 'Summary']);
    expect(workbook.getWorksheet('Monthly Budget')?.getCell('B2').value).toBe(1500);
    expect(workbook.getWorksheet('Monthly Budget')?.getCell('A1').fill).toMatchObject({ fgColor: { argb: 'FF155E59' } });
    expect(workbook.getWorksheet('Monthly Budget')?.getCell('B2').numFmt).toBe('$#,##0.00;[Red]-$#,##0.00');
    expect(workbook.getWorksheet('Summary')?.getCell('B2').value).toBe(2);
    expect(workbook.getWorksheet('Summary')?.getCell('B3').value).toMatchObject({ formula: "'Monthly Budget'!B2*2", result: 3000 });
  });

  it('writes formula cells with cached calculated results into Excel', async () => {
    const workbookData: WorkspaceWorkbook = {
      schemaVersion: 2,
      id: 'formula-workbook',
      title: 'Formula Test',
      sheets: [{
        id: 'formula-sheet',
        name: 'Sheet1',
        columns: [
          { id: 'formula-column-a', name: 'Item', kind: 'text' },
          { id: 'formula-column-b', name: 'Quantity', kind: 'number' },
          { id: 'formula-column-c', name: 'Total', kind: 'number' },
        ],
        rows: [{
          id: 'formula-row',
          cells: [
            { type: 'value', value: 'Pens' },
            { type: 'value', value: 2 },
            { type: 'formula', formula: '=B2*3', result: 6 },
          ],
        }, {
          id: 'formula-error-row',
          cells: [
            { type: 'value', value: 'Invalid' },
            { type: 'value', value: null },
            { type: 'formula', formula: '=1/0', result: null, error: '#DIV/0!' },
          ],
        }],
      }],
    };
    const buffer = await buildWorkspaceWorkbookXlsx(workbookData);
    const output = new ExcelJS.Workbook();
    await output.xlsx.load(buffer);

    expect(output.getWorksheet('Sheet1')?.getCell('C2').value).toMatchObject({ formula: 'B2*3', result: 6 });
    expect(output.getWorksheet('Sheet1')?.getCell('C3').value).toEqual({ formula: '1/0' });
  });

  it('accepts valid cross-sheet formula references and rejects missing sheets', () => {
    const workbook: WorkspaceWorkbook = {
      ...validWorkbook,
      sheets: [
        validWorkbook.sheets[0],
        {
          id: 'summary-sheet',
          name: 'Summary',
          columns: [{ id: 'summary-metric', name: 'Metric', kind: 'text' }, { id: 'summary-value', name: 'Value', kind: 'number' }],
          rows: [{ id: 'summary-row', cells: [
            { type: 'value', value: 'Budget' },
            { type: 'formula', formula: "='Monthly Budget'!B2*2", result: 3000 },
          ] }],
        },
      ],
    };

    expect(validateWorkspaceWorkbook(workbook)).toEqual(workbook);
    expect(validateWorkspaceWorkbook({
      ...workbook,
      sheets: [workbook.sheets[0], {
        ...workbook.sheets[1],
        rows: [{ ...workbook.sheets[1].rows[0], cells: [
          { type: 'value', value: 'Budget' },
          { type: 'formula', formula: '=Missing!B2*2', result: null },
        ] }],
      }],
    })).toBeNull();
  });

  it('rejects formula cells outside the deterministic mobile whitelist', () => {
    const unsafeWorkbook: WorkspaceWorkbook = {
      schemaVersion: 2,
      id: 'unsafe-workbook',
      title: 'Unsafe Formula',
      sheets: [{
        id: 'unsafe-sheet',
        name: 'Sheet1',
        columns: [{ id: 'unsafe-column', name: 'Output', kind: 'text' }],
        rows: [{ id: 'unsafe-row', cells: [{ type: 'formula', formula: '=WEBSERVICE("https://example.invalid")', result: null }] }],
      }],
    };
    expect(validateWorkspaceWorkbook(unsafeWorkbook)).toBeNull();
      expect(validateWorkspaceWorkbook({
        ...unsafeWorkbook,
        sheets: [{ ...unsafeWorkbook.sheets[0], rows: [{ id: 'unsafe-row', cells: [{ type: 'formula', formula: '=K2+1', result: null }] }] }],
      })).toBeNull();
  });
});