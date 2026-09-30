import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export const MAX_WORKSPACE_SHEETS = 10;
export const MAX_WORKSPACE_COLUMNS = 10;
export const MAX_WORKSPACE_ROWS = 75;
const MAX_CELL_LENGTH = 500;

export type WorkspaceColumnKind = 'text' | 'number' | 'currency' | 'percent' | 'date';
export type WorkspaceFormulaError = '#REF!' | '#VALUE!' | '#DIV/0!' | '#NAME?' | '#CIRCULAR!';
export type WorkspaceCellValue =
  | { type: 'value'; value: string | number | null }
  | { type: 'formula'; formula: string; result: number | null; error?: WorkspaceFormulaError };

export interface WorkspaceColumn {
  id: string;
  name: string;
  kind: WorkspaceColumnKind;
}

export interface WorkspaceRow {
  id: string;
  cells: WorkspaceCellValue[];
}

export interface WorkspaceSheet {
  id: string;
  name: string;
  columns: WorkspaceColumn[];
  rows: WorkspaceRow[];
}

export interface WorkspaceWorkbook {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  title: string;
  sheets: WorkspaceSheet[];
}

export interface LegacyWorkspaceSpreadsheet {
  title: string;
  columns: Array<{ name: string; kind: WorkspaceColumnKind }>;
  rows: Array<Array<string | number | null>>;
}

interface GeneratedWorkspaceSpreadsheet {
  title: string;
  columns: Array<{ name: string; kind: WorkspaceColumnKind }>;
  rows: Array<Array<string | number | null>>;
}

const COLUMN_KINDS = new Set<WorkspaceColumnKind>(['text', 'number', 'currency', 'percent', 'date']);
const INVALID_SHEET_NAME = /[\\/*?:\[\]]/;
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKSPACE_FORMULA_FUNCTIONS = /\b(?:SUM|AVERAGE|MIN|MAX)\b(?=\s*\()/g;
const WORKSPACE_FORMULA_CELL_REFERENCE = /(^|[^A-Z0-9_.])(?:(?:'((?:[^']|'')+)'|([A-Z_][A-Z0-9_]*))!)?\$?([A-Z]{1,2})\$?(\d+)(?:\s*:\s*\$?([A-Z]{1,2})\$?(\d+))?(?![A-Z0-9_])/g;

export function isSupportedWorkspaceFormulaSource(formula: string, sheetNames?: ReadonlySet<string>): boolean {
  let expression = formula.slice(1).toUpperCase();
  if (!formula.startsWith('=') || formula.length > MAX_CELL_LENGTH || /["\[\]{};=<>\\]/.test(expression)) return false;
  for (const match of expression.matchAll(WORKSPACE_FORMULA_CELL_REFERENCE)) {
    const quotedSheet = match[2]?.replace(/''/g, "'");
    const sheetName = quotedSheet ?? match[3];
    if (sheetName && sheetNames && !sheetNames.has(sheetName.toLocaleUpperCase('en-US'))) return false;
    for (const [columnText, rowText] of [[match[4], match[5]], [match[6], match[7]]] as const) {
      if (!columnText || !rowText) continue;
      let column = 0;
      for (const character of columnText) column = column * 26 + character.charCodeAt(0) - 64;
      const row = Number(rowText);
      if (column < 1 || column > MAX_WORKSPACE_COLUMNS || row < 1 || row > MAX_WORKSPACE_ROWS + 1) return false;
    }
  }
  expression = expression.replace(WORKSPACE_FORMULA_CELL_REFERENCE, (_match, prefix: string) => `${prefix}1`);
  expression = expression.replace(WORKSPACE_FORMULA_FUNCTIONS, '');
  return /^[0-9\s.,()+*/-]*$/.test(expression);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateGeneratedSpreadsheet(value: unknown): GeneratedWorkspaceSpreadsheet | null {
  if (!isRecord(value)) return null;
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120) return null;
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > MAX_WORKSPACE_COLUMNS) return null;
  if (!Array.isArray(value.rows) || value.rows.length > MAX_WORKSPACE_ROWS) return null;

  const columns: GeneratedWorkspaceSpreadsheet['columns'] = [];
  for (const column of value.columns) {
    if (!isRecord(column)) return null;
    const { name, kind } = column;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || !COLUMN_KINDS.has(kind as WorkspaceColumnKind)) return null;
    columns.push({ name: name.trim(), kind: kind as WorkspaceColumnKind });
  }

  const rows: Array<Array<string | number | null>> = [];
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return null;
    const cells: Array<string | number | null> = [];
    for (const cell of row) {
      if (cell === null) {
        cells.push(null);
      } else if (typeof cell === 'string' && cell.length <= MAX_CELL_LENGTH) {
        cells.push(cell);
      } else if (typeof cell === 'number' && Number.isFinite(cell)) {
        cells.push(cell);
      } else {
        return null;
      }
    }
    rows.push(cells);
  }

  return { title: value.title.trim(), columns, rows };
}

export function validateWorkspaceWorkbook(value: unknown): WorkspaceWorkbook | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== WORKSPACE_SCHEMA_VERSION)) return null;
  const legacySchema = value.schemaVersion === 1;
  if (typeof value.id !== 'string' || !VALID_ID.test(value.id)) return null;
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120) return null;
  if (!Array.isArray(value.sheets) || value.sheets.length < 1 || value.sheets.length > MAX_WORKSPACE_SHEETS) return null;

  const ids = new Set<string>([value.id]);
  const names = new Set<string>();
  const normalizedSheetNames = new Set<string>(value.sheets.flatMap((sheet) =>
    isRecord(sheet) && typeof sheet.name === 'string' ? [sheet.name.trim().toLocaleUpperCase('en-US')] : [],
  ));
  const addId = (id: unknown) => {
    if (typeof id !== 'string' || !VALID_ID.test(id) || ids.has(id)) return false;
    ids.add(id);
    return true;
  };
  const sheets: WorkspaceSheet[] = [];

  for (const rawSheet of value.sheets) {
    if (!isRecord(rawSheet) || !addId(rawSheet.id)) return null;
    if (typeof rawSheet.name !== 'string' || !rawSheet.name.trim() || rawSheet.name.length > 31 || INVALID_SHEET_NAME.test(rawSheet.name)) return null;
    const normalizedName = rawSheet.name.trim().toLocaleLowerCase('en-US');
    if (names.has(normalizedName)) return null;
    names.add(normalizedName);
    if (!Array.isArray(rawSheet.columns) || rawSheet.columns.length < 1 || rawSheet.columns.length > MAX_WORKSPACE_COLUMNS) return null;
    if (!Array.isArray(rawSheet.rows) || rawSheet.rows.length > MAX_WORKSPACE_ROWS) return null;

    const columns: WorkspaceColumn[] = [];
    for (const rawColumn of rawSheet.columns) {
      if (!isRecord(rawColumn) || !addId(rawColumn.id)) return null;
      const { name, kind } = rawColumn;
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || !COLUMN_KINDS.has(kind as WorkspaceColumnKind)) return null;
      columns.push({ id: rawColumn.id as string, name: name.trim(), kind: kind as WorkspaceColumnKind });
    }

    const rows: WorkspaceRow[] = [];
    for (const rawRow of rawSheet.rows) {
      if (!isRecord(rawRow) || !addId(rawRow.id) || !Array.isArray(rawRow.cells) || rawRow.cells.length !== columns.length) return null;
      const cells: WorkspaceCellValue[] = [];
      for (const cell of rawRow.cells) {
        if (legacySchema) {
          if (cell === null || (typeof cell === 'string' && cell.length <= MAX_CELL_LENGTH) || (typeof cell === 'number' && Number.isFinite(cell))) {
            cells.push({ type: 'value', value: cell as string | number | null });
            continue;
          }
          return null;
        }
        if (!isRecord(cell)) return null;
        if (cell.type === 'value') {
          if (cell.value === null || (typeof cell.value === 'string' && cell.value.length <= MAX_CELL_LENGTH) || (typeof cell.value === 'number' && Number.isFinite(cell.value))) {
            cells.push({ type: 'value', value: cell.value as string | number | null });
            continue;
          }
          return null;
        }
        if (cell.type !== 'formula' || typeof cell.formula !== 'string' || !isSupportedWorkspaceFormulaSource(cell.formula, normalizedSheetNames)) return null;
        if (cell.result !== null && (typeof cell.result !== 'number' || !Number.isFinite(cell.result))) return null;
        if (cell.error !== undefined && !['#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#CIRCULAR!'].includes(String(cell.error))) return null;
        cells.push({ type: 'formula', formula: cell.formula, result: cell.result as number | null, ...(cell.error ? { error: cell.error as WorkspaceFormulaError } : {}) });
      }
      rows.push({ id: rawRow.id as string, cells });
    }

    sheets.push({ id: rawSheet.id as string, name: rawSheet.name.trim(), columns, rows });
  }

  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, id: value.id, title: value.title.trim(), sheets };
}

export function createWorkspaceWorkbookFromLegacySpreadsheet(value: unknown): WorkspaceWorkbook | null {
  const generated = validateGeneratedSpreadsheet(value);
  if (!generated) return null;
  const sheetName = generated.title.replace(/[\\/*?:\[\]]/g, ' ').slice(0, 31).trim() || 'Sheet1';
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: randomUUID(),
    title: generated.title,
    sheets: [{
      id: randomUUID(),
      name: sheetName,
      columns: generated.columns.map((column) => ({ id: randomUUID(), ...column })),
      rows: generated.rows.map((cells) => ({ id: randomUUID(), cells: cells.map((value) => ({ type: 'value' as const, value })) })),
    }],
  };
}

export function toLegacyWorkspaceSpreadsheet(workbook: WorkspaceWorkbook): LegacyWorkspaceSpreadsheet {
  const sheet = workbook.sheets[0];
  return {
    title: workbook.title,
    columns: sheet.columns.map(({ name, kind }) => ({ name, kind })),
    rows: sheet.rows.map((row) => row.cells.map((cell) => cell.type === 'value' ? cell.value : cell.error ?? cell.result)),
  };
}
export function parseGeneratedWorkspaceSpreadsheet(text: string): WorkspaceWorkbook {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('The generated spreadsheet was not valid JSON.');
  }

  const generated = validateGeneratedSpreadsheet(parsed);
  if (!generated || generated.rows.length === 0) {
    throw new Error('The generated spreadsheet did not match the required format.');
  }
  const workbook = createWorkspaceWorkbookFromLegacySpreadsheet(generated);
  if (!workbook) throw new Error('The generated spreadsheet did not match the required format.');
  return workbook;
}

function normalizeNumericCell(value: string | number | null, kind: WorkspaceColumnKind): string | number | null {
  if (kind === 'text' || kind === 'date' || typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/[$,%\s,]/g, '');
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return value;
  return kind === 'percent' && value.includes('%') ? parsed / 100 : parsed;
}

function buildWorksheet(workbook: ExcelJS.Workbook, sheet: WorkspaceSheet) {
  const worksheet = workbook.addWorksheet(sheet.name);
  worksheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];
  worksheet.columns = sheet.columns.map((column, index) => {
    const widestCell = Math.max(column.name.length, ...sheet.rows.map((row) => String(row.cells[index] ?? '').length));
    return { header: column.name, key: column.id, width: Math.min(Math.max(widestCell + 2, 12), 36) };
  });

  const header = worksheet.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { name: 'Aptos', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF155E59' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  for (const row of sheet.rows) {
    const excelRow = worksheet.addRow(row.cells.map((cell, index) => {
      if (cell.type === 'value') return normalizeNumericCell(cell.value, sheet.columns[index].kind);
      const result = cell.result ?? undefined;
      return { formula: cell.formula.replace(/^=/, ''), ...(result === undefined ? {} : { result }) };
    }));
    excelRow.eachCell((cell, columnNumber) => {
      cell.font = { name: 'Aptos', size: 10, color: { argb: 'FF202123' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE6E6E3' } } };
      const kind = sheet.columns[columnNumber - 1].kind;
      if (kind === 'currency') cell.numFmt = '$#,##0.00;[Red]-$#,##0.00';
      else if (kind === 'percent') cell.numFmt = '0.0%';
      else if (kind === 'number') cell.numFmt = '#,##0.##';
      if (kind !== 'text') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
  }

  if (sheet.rows.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rows.length + 1, column: sheet.columns.length },
    };
  }
}

export async function buildWorkspaceWorkbookXlsx(value: unknown): Promise<Buffer> {
  const data = validateWorkspaceWorkbook(value);
  if (!data) throw new Error('The workbook data is invalid.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mento';
  workbook.subject = `Mento Workspace workbook: ${data.title}`;
  workbook.calcProperties = { fullCalcOnLoad: true };
  for (const sheet of data.sheets) buildWorksheet(workbook, sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}