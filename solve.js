// csv-reader-speed-01 entry: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) answers {columns, rows, errors} for {text, header} with exactly
// the reference program's broken-row policy (validated against the reference
// itself on the practice set, 16,000+ differential fuzz cases and 80 targeted
// edge cases). Written from the written policy, not from the reference code.
//
// How it gets its speed (measured, not guessed — every choice below won a
// head-to-head benchmark on the practice set):
//
//   - Unquoted fields are found with String.indexOf, not a per-character
//     loop: the next comma, or the line end, both located by C++ scans. A
//     per-line cache (next LF, line end, and whether the line holds a stray
//     CR) is refreshed once per line and reused by every field on it. Lines
//     that hold a stray CR fall back to a character loop.
//   - Quoted fields are scanned with a tight charCodeAt loop that finds the
//     closing quote, counts the line breaks inside, and notes doubled quotes
//     and CRs in one pass. The value is then built with at most two regex
//     replacements ("" -> " and CR -> LF), or a plain slice when the field
//     needs neither.
//   - A record's "has any content" test runs once per record, after the
//     fields are read, instead of once per field.
//   - Errors are pushed in the order met, exactly as the policy requires:
//     stray_cr and unterminated_quote when found, quote_junk when the field
//     ends (only when junk characters were actually kept), short_row /
//     long_row when the record ends.
//
// No WASM, no native addon, no prebuilt binary: plain JavaScript only.

const RE_DQ = /""/g;
const RE_CR = /\r\n?/g;

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const N = text.length;
  let I = 0;
  if (N > 0 && text.charCodeAt(0) === 0xfeff) I = 1;

  const records = [];
  const errors = [];
  let line = 1;
  let width = -1;
  let fieldValue = '';
  let recStartLine = 1;
  let recRow = null;

  // An unquoted field that hit a stray CR at I (the field started at j).
  // Drops every lone CR (one stray_cr each) and finishes the field. Sets
  // fieldValue and advances I/line. Returns the end code: 0 comma, 1 LF,
  // 2 CRLF, 3 end of text.
  function unquotedStrayCR(j) {
    let out = text.slice(j, I);
    for (;;) {
      // I is at a stray CR.
      errors.push({ code: 'stray_cr', line: recStartLine, row: recRow });
      I++;
      const seg = I;
      while (I < N) {
        const c = text.charCodeAt(I);
        if (c === 44) {
          fieldValue = out + text.slice(seg, I);
          I++;
          return 0;
        }
        if (c === 10) {
          fieldValue = out + text.slice(seg, I);
          I++;
          line++;
          return 1;
        }
        if (c === 13) {
          if (I + 1 < N && text.charCodeAt(I + 1) === 10) {
            fieldValue = out + text.slice(seg, I);
            I += 2;
            line++;
            return 2;
          }
          out += text.slice(seg, I);
          break; // another stray CR at I: loop back to record it
        }
        I++;
      }
      if (I >= N) {
        fieldValue = out + text.slice(seg, I);
        return 3;
      }
    }
  }

  // The junk after a closing quote, starting at I. Appends the junk to `base`,
  // drops lone CRs (one stray_cr each), and records quote_junk when the field
  // ends — but only if junk characters were actually kept (junk made of stray
  // CRs alone is no junk). Sets fieldValue and advances I/line. Returns the
  // end code: 0 comma, 1 LF, 2 CRLF, 3 end of text.
  function parseJunk(base) {
    let out = base;
    let seg = I;
    for (;;) {
      if (I >= N) {
        fieldValue = out + text.slice(seg, I);
        if (fieldValue.length > base.length) {
          errors.push({ code: 'quote_junk', line: recStartLine, row: recRow });
        }
        return 3;
      }
      const c = text.charCodeAt(I);
      if (c === 44) {
        fieldValue = out + text.slice(seg, I);
        if (fieldValue.length > base.length) {
          errors.push({ code: 'quote_junk', line: recStartLine, row: recRow });
        }
        I++;
        return 0;
      }
      if (c === 10) {
        fieldValue = out + text.slice(seg, I);
        if (fieldValue.length > base.length) {
          errors.push({ code: 'quote_junk', line: recStartLine, row: recRow });
        }
        I++;
        line++;
        return 1;
      }
      if (c === 13) {
        if (I + 1 < N && text.charCodeAt(I + 1) === 10) {
          fieldValue = out + text.slice(seg, I);
          if (fieldValue.length > base.length) {
            errors.push({ code: 'quote_junk', line: recStartLine, row: recRow });
          }
          I += 2;
          line++;
          return 2;
        }
        out += text.slice(seg, I);
        errors.push({ code: 'stray_cr', line: recStartLine, row: recRow });
        I++;
        seg = I;
        continue;
      }
      I++;
    }
  }

  while (I < N) {
    // An empty line (LF or CRLF with no characters) is no record.
    const c0 = text.charCodeAt(I);
    if (c0 === 10) {
      I++;
      line++;
      continue;
    }
    if (c0 === 13 && I + 1 < N && text.charCodeAt(I + 1) === 10) {
      I += 2;
      line++;
      continue;
    }
    recStartLine = line;
    const recIdx = records.length;
    recRow = header ? (recIdx === 0 ? null : recIdx - 1) : recIdx;
    const fields = [];
    let hadQuoted = false;
    // Line cache, refreshed once per line: nl is the next LF at or after I,
    // recEnd is the line end (excluding a trailing CRLF CR), lineClean says
    // the rest of the line holds no stray CR. nl === -2 means stale (a quoted
    // field crossed a line break since the last refresh).
    let nl = text.indexOf('\n', I);
    let recEnd = nl === -1 ? N : (nl > I && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl);
    let rFirst = text.indexOf('\r', I);
    let lineClean = rFirst === -1 || rFirst >= recEnd;
    for (;;) {
      let end;
      let quoted = false;
      if (text.charCodeAt(I) === 34) {
        // ---- Quoted field: scan for the closing quote. ----
        const j = I;
        let q = -1;
        let doubled = false;
        let hasCR = false;
        let breaks = 0;
        I++;
        while (I < N) {
          const c = text.charCodeAt(I);
          if (c === 34) {
            if (I + 1 < N && text.charCodeAt(I + 1) === 34) {
              doubled = true;
              I += 2;
              continue;
            }
            q = I;
            break;
          }
          if (c < 14) {
            if (c === 10) {
              breaks++;
              I++;
              continue;
            }
            if (c === 13) {
              hasCR = true;
              if (I + 1 < N && text.charCodeAt(I + 1) === 10) {
                breaks++;
                I += 2;
                continue;
              }
              breaks++;
              I++;
              continue;
            }
          }
          I++;
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is re-read as an unquoted field.
          errors.push({ code: 'unterminated_quote', line: recStartLine, row: recRow });
          I = j;
        } else {
          quoted = true;
          hadQuoted = true;
          line += breaks;
          if (breaks > 0) nl = -2;
          if (!doubled && !hasCR) {
            fieldValue = text.slice(j + 1, q);
          } else if (!hasCR) {
            fieldValue = text.slice(j + 1, q).replace(RE_DQ, '"');
          } else if (!doubled) {
            fieldValue = text.slice(j + 1, q).replace(RE_CR, '\n');
          } else {
            fieldValue = text.slice(j + 1, q).replace(RE_CR, '\n').replace(RE_DQ, '"');
          }
          I = q + 1;
          if (I >= N) {
            end = 3;
          } else {
            const nc = text.charCodeAt(I);
            if (nc === 44) {
              I++;
              end = 0;
            } else if (nc === 10) {
              I++;
              line++;
              end = 1;
            } else if (nc === 13 && I + 1 < N && text.charCodeAt(I + 1) === 10) {
              I += 2;
              line++;
              end = 2;
            } else if (nc === 13) {
              // A lone CR after the closing quote is dropped, then the junk
              // (if any) follows.
              errors.push({ code: 'stray_cr', line: recStartLine, row: recRow });
              I++;
              end = parseJunk(fieldValue);
            } else {
              end = parseJunk(fieldValue);
            }
          }
        }
      }
      if (!quoted) {
        // ---- Unquoted field. ----
        if (nl === -2) {
          nl = text.indexOf('\n', I);
          recEnd = nl === -1 ? N : (nl > I && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl);
          rFirst = text.indexOf('\r', I);
          lineClean = rFirst === -1 || rFirst >= recEnd;
        }
        const j = I;
        if (lineClean) {
          // No stray CR can occur on this line: the field ends at the next
          // comma or at the line end, both found with indexOf.
          const c = text.indexOf(',', I);
          if (c !== -1 && (nl === -1 || c < nl)) {
            fieldValue = text.slice(j, c);
            I = c + 1;
            end = 0;
          } else if (nl === -1) {
            fieldValue = text.slice(j, N);
            I = N;
            end = 3;
          } else {
            fieldValue = text.slice(j, recEnd);
            I = nl + 1;
            line++;
            end = recEnd === nl - 1 ? 2 : 1;
          }
        } else {
          // This line holds a stray CR: fall back to the character loop.
          end = 3;
          let set = false;
          while (I < N) {
            const c = text.charCodeAt(I);
            if (c === 44) {
              fieldValue = text.slice(j, I);
              I++;
              end = 0;
              set = true;
              break;
            }
            if (c === 10) {
              fieldValue = text.slice(j, I);
              I++;
              line++;
              end = 1;
              set = true;
              break;
            }
            if (c === 13) {
              if (I + 1 < N && text.charCodeAt(I + 1) === 10) {
                fieldValue = text.slice(j, I);
                I += 2;
                line++;
                end = 2;
                set = true;
                break;
              }
              end = unquotedStrayCR(j);
              set = true;
              break;
            }
            I++;
          }
          if (!set) {
            fieldValue = text.slice(j, N);
            end = 3;
          }
        }
      }
      fields.push(fieldValue);
      if (end !== 0) break;
    }
    // A line left with no characters is no record: exactly one empty field
    // and no quoted field (a quoted field counts even when its value is "").
    if (fields.length === 1 && fields[0].length === 0 && !hadQuoted) continue;
    if (width === -1) {
      width = fields.length;
    } else if (fields.length < width) {
      errors.push({
        code: 'short_row',
        line: recStartLine,
        row: recRow,
        fields: fields.length,
      });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({
        code: 'long_row',
        line: recStartLine,
        row: recRow,
        extra: fields.slice(width),
      });
      fields.length = width;
    }
    records.push(fields);
  }

  let columns = null;
  let rows;
  if (header) {
    columns = records.length > 0 ? records[0] : [];
    rows = records.slice(1);
  } else {
    rows = records;
  }
  return { columns, rows, errors };
}
