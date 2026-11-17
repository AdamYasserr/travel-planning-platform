import { csvCell, toCsv } from './csv';

describe('CSV cells (FLT-29), safe against CSV injection', () => {
  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['Taylor Passenger', 'Taylor Passenger'],
    ['Doe, John', '"Doe, John"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['a-b', 'a-b'],
    ['', ''],
  ])('%j -> %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('null and undefined are empty cells; numbers are written as is', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(3)).toBe('3');
  });

  it('joins rows with commas and CRLF', () => {
    expect(toCsv([['a', 'b'], ['=1', 'x,y']])).toBe(`a,b\r\n'=1,"x,y"\r\n`);
  });
});
