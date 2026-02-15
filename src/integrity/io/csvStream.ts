import fs from "node:fs";
import { parse } from "csv-parse";

export type CsvStreamOptions = {
  hasHeader?: boolean;        // default true
  delimiter?: string;         // default ','
  relaxColumnCount?: boolean; // default true
};

export type CsvRow = Record<string, string> | string[];

/**
 * Stream CSV rows without loading entire file into memory.
 */
export async function streamCsvRows(args: {
  filePath: string;
  onRow: (row: CsvRow, rowIndex: number) => void | Promise<void>;
  opts?: CsvStreamOptions;
}): Promise<{ rows: number }> {
  const { filePath, onRow } = args;
  const opts = args.opts ?? {};

  const hasHeader = opts.hasHeader ?? true;
  const delimiter = opts.delimiter ?? ",";
  const relaxColumnCount = opts.relaxColumnCount ?? true;

  return new Promise((resolve, reject) => {
    let rows = 0;

    const input = fs.createReadStream(filePath);

    const parser = parse({
      columns: hasHeader,
      delimiter,
      relax_column_count: relaxColumnCount,
      bom: true,
      trim: false,
      skip_empty_lines: true,
    });

    parser.on("readable", async () => {
      try {
        let record: any;
        // eslint-disable-next-line no-cond-assign
        while ((record = parser.read()) !== null) {
          const idx = rows;
          rows += 1;
          await onRow(record, idx);
        }
      } catch (e) {
        reject(e);
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => resolve({ rows }));

    input.on("error", (err) => reject(err));
    input.pipe(parser);
  });
}
