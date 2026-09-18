export type JsonlPrimitive = string | number | boolean | null;

export type JsonlArray = readonly JsonlValue[];

export type JsonlObject = { readonly [key: string]: JsonlValue };

export type JsonlValue = JsonlPrimitive | JsonlArray | JsonlObject;

export interface JsonlFile {
  readonly path: string;

  /** Appends one JSON-serialized value followed by a newline. */
  append(value: JsonlValue): Promise<void>;

  /** Streams values from the file by parsing one JSON value per line. */
  read(): AsyncIterable<JsonlValue>;

  /** Flushes pending appends and closes the underlying append stream. */
  close(): Promise<void>;
}
