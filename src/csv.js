/**
 * Minimal, strict CSV parser (RFC 4180 style) with no dependencies.
 *
 * Supported: comma delimiter, double-quoted fields, commas / line breaks / blank lines
 * inside quotes, "" as an escaped quote, CRLF / LF / CR line endings, and a UTF-8 BOM.
 *
 * Rows are numbered the way a spreadsheet numbers them: the header is row 1, the first
 * data record is row 2, and a quoted field that contains a line break is still ONE row.
 *
 * Structural problems (unterminated quotes, stray quotes) throw CsvParseError, because
 * after such a problem the record boundaries can no longer be trusted.
 */

export class CsvParseError extends Error {
  constructor(message, { row = null } = {}) {
    super(message);
    this.name = 'CsvParseError';
    this.row = row;
  }
}

/**
 * @param {string} text
 * @returns {{ records: Array<{ row: number, fields: string[], blank: boolean }> }}
 *   `blank` is true for empty lines and for rows whose cells are all empty.
 */
export function parseCsv(text) {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];

  let fields = [];
  let field = '';
  let row = 1;
  let inQuotes = false;
  let quoteOpenedInRow = 1;
  let fieldWasQuoted = false;
  let afterClosingQuote = false;
  let recordHasContent = false; // any character seen in this record (including delimiters)

  const endField = () => {
    fields.push(field);
    field = '';
    fieldWasQuoted = false;
    afterClosingQuote = false;
  };

  const endRecord = () => {
    endField();
    const blank = fields.every((value) => value.trim() === '');
    records.push({ row, fields, blank });
    fields = [];
    row += 1;
    recordHasContent = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; afterClosingQuote = true; }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      endRecord();
      continue;
    }

    recordHasContent = true;

    if (char === ',') { endField(); continue; }

    if (afterClosingQuote) {
      throw new CsvParseError(
        `Row ${row}: unexpected character "${char}" after a closing quote. A quoted field must be followed by a comma or the end of the line.`,
        { row },
      );
    }

    if (char === '"') {
      if (field === '' && !fieldWasQuoted) {
        inQuotes = true;
        fieldWasQuoted = true;
        quoteOpenedInRow = row;
      } else {
        throw new CsvParseError(
          `Row ${row}: a quote character appears inside an unquoted field. Wrap the whole value in double quotes and write each inner quote twice (for example "27"" monitor").`,
          { row },
        );
      }
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new CsvParseError(
      `Row ${quoteOpenedInRow}: a quoted field is never closed (missing closing double quote). Everything after it would be read as one cell.`,
      { row: quoteOpenedInRow },
    );
  }

  // Final record without a trailing line break.
  if (recordHasContent || field !== '' || fields.length > 0 || fieldWasQuoted) endRecord();

  return { records };
}
