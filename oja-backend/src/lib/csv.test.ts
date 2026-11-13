import { describe, expect, it } from "vitest";
import { escapeCsvField, needsQuoting, toCsv } from "./csv.js";

describe("needsQuoting", () => {
  it("returns false for plain alphanumeric and simple punctuation", () => {
    expect(needsQuoting("abc")).toBe(false);
    expect(needsQuoting("1250000.00")).toBe(false);
    expect(needsQuoting("RENT")).toBe(false);
    expect(needsQuoting("2026-08-17T00:00:00.000Z")).toBe(false);
  });

  it("returns true for commas, quotes, CR, and LF", () => {
    expect(needsQuoting("a,b")).toBe(true);
    expect(needsQuoting('a"b')).toBe(true);
    expect(needsQuoting("a\rb")).toBe(true);
    expect(needsQuoting("a\nb")).toBe(true);
  });
});

describe("escapeCsvField", () => {
  it("passes through values that need no quoting", () => {
    expect(escapeCsvField("1250000.00")).toBe("1250000.00");
  });

  it("quotes a field containing a comma", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields with line breaks", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("toCsv", () => {
  it("returns an empty string for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("emits a header row plus one row per record with CRLF endings", () => {
    const csv = toCsv([
      { period: "week", revenue: "1250000.00" },
      { period: "month", revenue: "5000000.00" },
    ]);
    expect(csv).toBe("period,revenue\r\nweek,1250000.00\r\nmonth,5000000.00\r\n");
  });

  it("quotes fields per RFC 4180", () => {
    const csv = toCsv([{ category: "RENT", note: 'a "quoted", item' }]);
    expect(csv).toBe('category,note\r\nRENT,"a ""quoted"", item"\r\n');
  });

  it("uses the first row's keys as the header in insertion order", () => {
    const csv = toCsv([{ a: "1", b: "2", c: "3" }]);
    expect(csv.startsWith("a,b,c\r\n")).toBe(true);
  });

  it("fills missing keys with empty strings on later rows", () => {
    const csv = toCsv([{ a: "1", b: "2" }, { a: "3" }]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,\r\n");
  });
});
