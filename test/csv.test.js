import test from 'node:test';
import assert from 'node:assert/strict';
import { CsvParseError, parseCsv } from '../src/csv.js';

const fields = (text) => parseCsv(text).records.map((record) => record.fields);

test('plain rows, numbered like a spreadsheet (header = row 1)', () => {
  const { records } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
  assert.deepEqual(records.map((r) => r.row), [1, 2, 3]);
  assert.deepEqual(records.map((r) => r.fields), [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('quoted fields: commas, escaped quotes and empty quoted values', () => {
  assert.deepEqual(fields('"USB-C Cable, 2 m",12.90,""\n'), [['USB-C Cable, 2 m', '12.90', '']]);
  assert.deepEqual(fields('"Café Carry Case ""Pro""",1'), [['Café Carry Case "Pro"', '1']]);
  assert.deepEqual(fields('"a ""quoted"" word, with comma"'), [['a "quoted" word, with comma']]);
});

test('line breaks and blank lines inside quotes belong to the field and stay ONE row', () => {
  const { records } = parseCsv('id,note\n1,"line one\n\nline three"\n2,next\n');
  assert.deepEqual(records.map((r) => r.row), [1, 2, 3]);
  assert.equal(records[1].fields[1], 'line one\n\nline three');
  assert.equal(records[2].fields[0], '2');
});

test('Windows (CRLF), Unix (LF) and old Mac (CR) line endings', () => {
  const expected = [['a', 'b'], ['1', '2'], ['3', '4']];
  assert.deepEqual(fields('a,b\r\n1,2\r\n3,4\r\n'), expected);
  assert.deepEqual(fields('a,b\n1,2\n3,4'), expected);
  assert.deepEqual(fields('a,b\r1,2\r3,4\r'), expected);
});

test('a UTF-8 BOM (what Excel writes) is ignored; UTF-8 text is preserved', () => {
  const { records } = parseCsv('\uFEFForder_id,customer\nORD-1,Zoë Müller 東京\n');
  assert.equal(records[0].fields[0], 'order_id');
  assert.equal(records[1].fields[1], 'Zoë Müller 東京');
});

test('a final line without a line break is still a record; a trailing break adds nothing', () => {
  assert.equal(parseCsv('a\nb').records.length, 2);
  assert.equal(parseCsv('a\nb\n').records.length, 2);
  assert.equal(parseCsv('').records.length, 0);
});

test('blank lines and all-empty rows are flagged blank but keep their row numbers', () => {
  const { records } = parseCsv('a,b\n\n1,2\n , \n3,4\n');
  assert.deepEqual(records.map((r) => [r.row, r.blank]), [[1, false], [2, true], [3, false], [4, true], [5, false]]);
});

test('empty fields and trailing commas are kept so column counts can be checked', () => {
  assert.deepEqual(fields('a,,c,\n'), [['a', '', 'c', '']]);
});

test('an unterminated quote is a clear error pointing at the row where it opened', () => {
  assert.throws(() => parseCsv('a,b\n1,"never closed\n2,3\n'), (error) => {
    assert.ok(error instanceof CsvParseError);
    assert.equal(error.row, 2);
    assert.match(error.message, /Row 2: a quoted field is never closed/);
    return true;
  });
});

test('a stray quote inside an unquoted field is rejected with advice', () => {
  assert.throws(() => parseCsv('id,product\n1,27" monitor\n'), (error) => {
    assert.equal(error.row, 2);
    assert.match(error.message, /quote character appears inside an unquoted field/);
    assert.match(error.message, /write each inner quote twice/);
    return true;
  });
});

test('text right after a closing quote is rejected', () => {
  assert.throws(() => parseCsv('"abc"def,1\n'), /unexpected character "d" after a closing quote/);
});
