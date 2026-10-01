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

  it('converts requested generated formulas into validated workbook formula cells', () => {
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

    const workbook = parseGeneratedWorkspaceSpreadsheet(JSON.stringify(generated));

    expect(workbook.sheets[0].rows[0].cells[2]).toEqual({ type: 'formula', formula: '=A2*B2', result: null });
    expect(validateWorkspaceWorkbook(workbook)).toEqual(workbook);
  });

  it('rejects unsafe, duplicate, and out-of-range generated formula targets', () => {
    const generated = {
      title: 'Sales',
      columns: [{ name: 'Value', kind: 'number' }],
      rows: [[10]],
      formulas: [{ cell: 'A2', formula: '=WEBSERVICE("https://example.invalid")' }],
    };

    expect(() => parseGeneratedWorkspaceSpreadsheet(JSON.stringify(generated))).toThrow(/required format/);
    expect(() => parseGeneratedWorkspaceSpreadsheet(JSON.stringify({
      ...generated,
      formulas: [{ cell: 'A2', formula: '=1+1' }, { cell: 'A2', formula: '=2+2' }],
    }))).toThrow(/required format/);
    expect(() => parseGeneratedWorkspaceSpreadsheet(JSON.stringify({
      ...generated,
      formulas: [{ cell: 'A3', formula: '=1+1' }],
    }))).toThrow(/required format/);
  });

  it('rebuilds incomplete category summaries from every unique data category', async () => {
    const generated = {
      title: 'Small Business Expenses',
      columns: [
        { name: 'Date', kind: 'date' },
        { name: 'Description', kind: 'text' },
        { name: 'Category', kind: 'text' },
        { name: 'Amount', kind: 'currency' },
        { name: 'Tax %', kind: 'percent' },
        { name: 'Tax Amount', kind: 'currency' },
        { name: 'Total Cost', kind: 'currency' },
        { name: 'Running Total', kind: 'currency' },
      ],
      rows: [
        ['2023-11-01', 'Office Supplies', 'Office', 120, 0.05, null, null, null],
        ['2023-11-03', 'Internet Bill', 'Utilities', 80, 0, null, null, null],
        ['2023-11-05', 'Client Lunch', 'Meals', 150, 0.08, null, null, null],
        ['2023-11-10', 'Software Subscription', 'Software', 49, 0, null, null, null],
        ['2023-11-12', 'Marketing Ads', 'Marketing', 300, 0, null, null, null],
        ['2023-11-19', 'Consulting Fee', 'Professional Services', 500, 0.1, null, null, null],
        ['Total', null, null, null, null, null, null, null],
        ['Office Total', 'Category Summary', 'Office', null, null, null, null, null],
        ['Utilities Total', 'Category Summary', 'Utilities', null, null, null, null, null],
        ['Meals Total', 'Category Summary', 'Meals', null, null, null, null, null],
      ],
      formulas: [
        { cell: 'F2', formula: '=D2*E2' }, { cell: 'G2', formula: '=D2+F2' },
        { cell: 'F3', formula: '=D3*E3' }, { cell: 'G3', formula: '=D3+F3' },
        { cell: 'F4', formula: '=D4*E4' }, { cell: 'G4', formula: '=D4+F4' },
        { cell: 'F5', formula: '=D5*E5' }, { cell: 'G5', formula: '=D5+F5' },
        { cell: 'F6', formula: '=D6*E6' }, { cell: 'G6', formula: '=D6+F6' },
        { cell: 'F7', formula: '=D7*E7' }, { cell: 'G7', formula: '=D7+F7' },
        { cell: 'D8', formula: '=SUM(D2:D7)' }, { cell: 'F8', formula: '=SUM(F2:F7)' }, { cell: 'G8', formula: '=SUM(G2:G7)' },
        { cell: 'G9', formula: '=SUM(G2)' }, { cell: 'G10', formula: '=SUM(G3)' }, { cell: 'G11', formula: '=SUM(G4)' },
      ],
    };

    const workbook = parseGeneratedWorkspaceSpreadsheet(
      JSON.stringify(generated),
      'Add a monthly total and a breakdown of total spending by category.',
    );
    const sheet = workbook.sheets[0];
    const categorySummaryRows = sheet.rows.filter((row) => row.cells[1].type === 'value' && row.cells[1].value === 'Category Summary');
    const categories = categorySummaryRows.map((row) => row.cells[2].type === 'value' ? row.cells[2].value : null);

    expect(categories).toEqual(['Office', 'Utilities', 'Meals', 'Software', 'Marketing', 'Professional Services']);
    expect(categorySummaryRows.map((row) => row.cells[6])).toEqual([
      { type: 'formula', formula: '=SUM(G2)', result: null },
      { type: 'formula', formula: '=SUM(G3)', result: null },
      { type: 'formula', formula: '=SUM(G4)', result: null },
      { type: 'formula', formula: '=SUM(G5)', result: null },
      { type: 'formula', formula: '=SUM(G6)', result: null },
      { type: 'formula', formula: '=SUM(G7)', result: null },
    ]);
    expect(validateWorkspaceWorkbook(workbook)).toEqual(workbook);

    const buffer = await buildWorkspaceWorkbookXlsx(workbook);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(buffer);
    expect(exported.getWorksheet('Small Business Expenses')?.getCell('C14').value).toBe('Professional Services');
    expect(exported.getWorksheet('Small Business Expenses')?.getCell('G14').value).toMatchObject({ formula: 'SUM(G7)' });
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