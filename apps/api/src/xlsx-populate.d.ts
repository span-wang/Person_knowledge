declare module 'xlsx-populate' {
  interface Cell {
    value(): unknown;
    value(value: unknown): Cell;
    style(name: string, value: unknown): Cell;
  }

  interface Column {
    width(value: number): Column;
  }

  interface Range {
    value(): unknown;
  }

  interface Worksheet {
    name(value: string): Worksheet;
    cell(row: number, column: number): Cell;
    column(column: number): Column;
    usedRange(): Range;
  }

  interface Workbook {
    sheet(nameOrIndex: string | number): Worksheet | undefined;
    outputAsync(type?: 'nodebuffer'): Promise<Buffer>;
  }

  interface XlsxPopulate {
    fromBlankAsync(): Promise<Workbook>;
    fromDataAsync(data: Buffer): Promise<Workbook>;
  }

  const xlsxPopulate: XlsxPopulate;
  export default xlsxPopulate;
}
