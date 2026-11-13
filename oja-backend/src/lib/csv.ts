/**
 * ============================================================
 * CSV SERIALIZER (RFC 4180)
 * ============================================================
 * The API's export helper, deliberately dependency-free. Rules:
 *
 *  - A field containing a comma, double quote, CR, or LF is wrapped in
 *    double quotes; embedded quotes are doubled (`"` -> `""`).
 *  - Lines end with CRLF. A trailing newline is emitted after the last
 *    row (spreadsheets expect it).
 *  - Values are exported as plain strings — money arrives as
 *    `toFixed(2)` strings so spreadsheets parse them as numbers (no
 *    thousands separators), timestamps as UTC ISO-8601.
 *
 * Header row: the keys of the first object, in insertion order.
 * ============================================================
 */

/** True when the field must be quoted per RFC 4180. */
export function needsQuoting(value: string): boolean {
  return /[",\r\n]/.test(value);
}

/**
 * Parses CSV text (RFC 4180 subset) into rows of fields. Handles quoted
 * fields (commas/newlines inside quotes), doubled quotes (`""` -> `"`),
 * and CRLF or LF line endings. Trailing empty rows are dropped. Throws
 * on a dangling quote at end of input.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const length = text.length;

  while (i < length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new Error("unterminated quoted field");
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((value) => value === "")) {
    rows.pop();
  }
  return rows;
}

/** Escapes a single CSV field: quote when needed, double embedded quotes. */
export function escapeCsvField(value: string): string {
  if (!needsQuoting(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Serializes rows to CSV text. `rows` may be empty: the result is an
 * empty string (no header, no rows).
 */
export function toCsv(rows: ReadonlyArray<Readonly<Record<string, string>>>): string {
  if (rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0] as Record<string, string>);
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escapeCsvField(row[key] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
