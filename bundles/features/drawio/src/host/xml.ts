import { inflateRawSync } from 'node:zlib';

import { DOMImplementation, DOMParser, XMLSerializer } from '@xmldom/xmldom';

import {
  MAX_CELLS,
  MAX_DIAGRAM_BYTES,
  MAX_PAGES,
  type PageSummary,
} from '../contracts/index.js';

/** What `normalizeDiagram` answers: the normalized file and its pages, or why it was refused. */
export type NormalizedDiagram =
  | { readonly xml: string; readonly pages: readonly PageSummary[] }
  | { readonly error: string };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const MAX_ID_LENGTH = 128;

/** A refusal raised inside the normalization and answered as `{ error }`. */
class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message);
};

const childElements = (node: Node): Element[] => {
  const out: Element[] = [];

  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) {
      out.push(child as Element);
    }
  }

  return out;
};

const forbidsDeclarations = (text: string, where: string): void => {
  if (/<!doctype|<!entity/i.test(text)) {
    refuse(
      `${where} has a DOCTYPE or ENTITY declaration, which is not accepted.`,
    );
  }
};

/** The xmldom message without its prefix and location. */
const cleanMessage = (message: string): string =>
  message
    .replace(/^\[xmldom [^\]]*\]\s*/, '')
    .replace(/\s*@#\[line:[^\]]*\]\s*$/, '')
    .trim();

/** Parses one XML document; any parser warning or error, or stray top-level text, is a refusal. */
const parseXml = (text: string, where: string): Element => {
  const problems: string[] = [];
  const collect = (message: string) => {
    problems.push(cleanMessage(String(message)));
  };
  let doc: Document;

  try {
    doc = new DOMParser({
      errorHandler: { warning: collect, error: collect, fatalError: collect },
    }).parseFromString(text, 'text/xml');
  } catch (error) {
    return refuse(
      `${where} is not well-formed XML: ${cleanMessage(error instanceof Error ? error.message : String(error))}.`,
    );
  }

  if (problems.length > 0) {
    return refuse(`${where} is not well-formed XML: ${problems[0]}.`);
  }

  const elements = childElements(doc);

  for (let child = doc.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE && (child.nodeValue ?? '').trim() !== '') {
      refuse(`${where} is not well-formed XML: text outside the root element.`);
    }
  }

  const [root] = elements;

  if (root === undefined || elements.length !== 1) {
    return refuse(
      `${where} is not well-formed XML: it needs exactly one root element.`,
    );
  }

  return root;
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The `mxGraphModel` of a compressed page: base64 → inflate → URI-decode → parse. */
const inflatePage = (
  text: string,
  pageId: string,
): { readonly model: Element; readonly bytes: number } => {
  const where = `Page "${pageId}"`;
  const compact = text.replace(/\s+/g, '');

  if (!BASE64.test(compact) || compact.length % 4 === 1) {
    return refuse(
      `${where} holds neither an mxGraphModel nor valid compressed text.`,
    );
  }

  let decoded: string;

  try {
    const inflated = inflateRawSync(Buffer.from(compact, 'base64'), {
      maxOutputLength: MAX_DIAGRAM_BYTES,
    });
    decoded = decodeURIComponent(inflated.toString('latin1'));
  } catch (error) {
    return refuse(
      error instanceof RangeError
        ? `${where} decompresses to more than ${MAX_DIAGRAM_BYTES} bytes.`
        : `${where} holds compressed text that cannot be decompressed.`,
    );
  }

  forbidsDeclarations(decoded, where);

  const model = parseXml(decoded, where);

  if (model.tagName !== 'mxGraphModel') {
    return refuse(
      `${where} decompresses to <${model.tagName}>, not an mxGraphModel.`,
    );
  }

  return { model, bytes: Buffer.byteLength(decoded, 'utf8') };
};

/** Checks the cells of one page; answers how many it has. */
const checkCells = (model: Element, pageId: string): number => {
  const where = `Page "${pageId}"`;
  const root = childElements(model).find(
    (element) => element.tagName === 'root',
  );

  if (root === undefined) {
    return refuse(`${where} has an mxGraphModel without a <root> element.`);
  }

  const cells = childElements(root);
  const ids = new Set<string>();
  const parents: string[] = [];

  for (const cell of cells) {
    const id = cell.getAttribute('id') ?? '';

    if (id === '') {
      refuse(`${where} has a cell without an id.`);
    }

    if (id.length > MAX_ID_LENGTH) {
      refuse(`${where} has a cell id longer than ${MAX_ID_LENGTH} characters.`);
    }

    if (ids.has(id)) {
      refuse(`${where} has two cells with id "${id}".`);
    }

    ids.add(id);

    const holder =
      cell.tagName === 'object' || cell.tagName === 'UserObject'
        ? childElements(cell).find((element) => element.tagName === 'mxCell')
        : cell;

    if (holder?.hasAttribute('parent')) {
      parents.push(holder.getAttribute('parent') ?? '');
    }
  }

  for (const parent of parents) {
    if (!ids.has(parent)) {
      refuse(`${where} has a cell whose parent "${parent}" does not exist.`);
    }
  }

  return cells.length;
};

const normalize = (text: string): NormalizedDiagram => {
  if (text.trim() === '') {
    return refuse('The file is empty.');
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_DIAGRAM_BYTES) {
    return refuse(`The file is larger than ${MAX_DIAGRAM_BYTES} bytes.`);
  }

  forbidsDeclarations(text, 'The file');

  const source = parseXml(text, 'The file');

  if (source.tagName !== 'mxfile' && source.tagName !== 'mxGraphModel') {
    return refuse(
      `The root element is <${source.tagName}>; expected <mxfile> or <mxGraphModel>.`,
    );
  }

  const doc = new DOMImplementation().createDocument(null, 'mxfile', null);
  const out: Element = doc.documentElement;
  const sourcePages: (Element | undefined)[] = [];
  const models: Element[] = [];

  if (source.tagName === 'mxfile') {
    for (let i = 0; i < source.attributes.length; i += 1) {
      const attribute = source.attributes.item(i);

      if (attribute !== null && attribute.name !== 'compressed') {
        out.setAttribute(attribute.name, attribute.value);
      }
    }

    sourcePages.push(
      ...childElements(source).filter(
        (element) => element.tagName === 'diagram',
      ),
    );
  } else {
    sourcePages.push(undefined);
    models.push(source);
  }

  out.setAttribute('compressed', 'false');

  if (sourcePages.length === 0) {
    return refuse('The file has no <diagram> page.');
  }

  if (sourcePages.length > MAX_PAGES) {
    return refuse(
      `The file has ${sourcePages.length} pages; the limit is ${MAX_PAGES}.`,
    );
  }

  const pages: PageSummary[] = [];
  const pageIds = new Set<string>();
  let decompressed = 0;
  let totalCells = 0;

  for (const [index, sourcePage] of sourcePages.entries()) {
    const n = index + 1;
    const page = doc.createElement('diagram');

    if (sourcePage !== undefined) {
      for (let i = 0; i < sourcePage.attributes.length; i += 1) {
        const attribute = sourcePage.attributes.item(i);

        if (attribute !== null) {
          page.setAttribute(attribute.name, attribute.value);
        }
      }
    }

    if ((page.getAttribute('id') ?? '') === '') {
      page.setAttribute('id', `page-${n}`);
    }

    if ((page.getAttribute('name') ?? '') === '') {
      page.setAttribute('name', `Página ${n}`);
    }

    const id = page.getAttribute('id') ?? '';
    const name = page.getAttribute('name') ?? '';

    if (pageIds.has(id)) {
      refuse(`Two pages have the id "${id}".`);
    }

    if (id.includes('/')) {
      refuse(`The page id "${id}" contains "/".`);
    }

    if (id.length > MAX_ID_LENGTH) {
      refuse(`A page id is longer than ${MAX_ID_LENGTH} characters.`);
    }

    pageIds.add(id);

    let model = models[index];

    if (sourcePage !== undefined) {
      const elements = childElements(sourcePage);

      if (elements.length > 0) {
        const [only] = elements;

        if (elements.length !== 1 || only?.tagName !== 'mxGraphModel') {
          refuse(
            `Page "${id}" must hold one mxGraphModel or its compressed text.`,
          );
        }

        model = only;
      } else {
        const inflated = inflatePage(sourcePage.textContent ?? '', id);

        decompressed += inflated.bytes;

        if (decompressed > MAX_DIAGRAM_BYTES) {
          refuse(
            `The pages decompress to more than ${MAX_DIAGRAM_BYTES} bytes in total.`,
          );
        }

        model = inflated.model;
      }
    }

    if (model === undefined) {
      return refuse(`Page "${id}" has no mxGraphModel.`);
    }

    const cells = checkCells(model, id);

    totalCells += cells;

    if (totalCells > MAX_CELLS) {
      refuse(`The diagram has more than ${MAX_CELLS} cells.`);
    }

    page.appendChild(doc.importNode(model, true));
    out.appendChild(page);
    pages.push({ id, name, cells });
  }

  return { xml: new XMLSerializer().serializeToString(doc), pages };
};

/**
 * Validates and normalizes a draw.io file (spec "Validação e normalização").
 * Accepts the text of an `mxfile` (compressed pages or not) or of a bare
 * `mxGraphModel`. Answers `{ xml, pages }`: `xml` is one `<mxfile … compressed="false">`
 * with one `<diagram>` per page holding its `mxGraphModel` as elements, no XML
 * declaration; `pages` lists each page in document order. Answers `{ error }`
 * with a one-sentence, model-readable reason on any violated rule (size in
 * UTF-8 bytes over MAX_DIAGRAM_BYTES, DOCTYPE/ENTITY, any parser warning or
 * error, wrong root, page count, page ids, decompression, MAX_CELLS, cell ids,
 * parents). Never throws. Pure and deterministic: the same input gives the
 * same bytes, and normalizing an `xml` it produced gives the same `xml` back.
 */
export const normalizeDiagram = (text: string): NormalizedDiagram => {
  try {
    return normalize(text);
  } catch (error) {
    if (error instanceof Refusal) {
      return { error: error.message };
    }

    return {
      error: `The diagram could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
};
