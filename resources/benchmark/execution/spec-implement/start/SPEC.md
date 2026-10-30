# parse(text)

`parse(text)` in csv.js returns the rows of a CSV document as an array of rows, each an
array of strings.

- Fields are separated by commas; rows by `\n` or `\r\n`.
- A field may be enclosed in double quotes. Inside quotes, commas and line breaks are part
  of the field, and a doubled quote (`""`) stands for one quote character.
- Unquoted fields are taken exactly as written: no trimming.
- Empty fields are empty strings: `a,,b` is `["a", "", "b"]`, and a line that ends with a
  comma has a final empty field.
- A line break at the very end of the text does not produce an extra row, and an empty
  text gives `[]`.
- A quoted field that is never closed throws an Error whose message includes the 1-based
  line number where that field started.
