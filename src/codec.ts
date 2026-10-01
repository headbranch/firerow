// Converts between Firestore values, a portable JSON form (used in snapshots),
// and the text shown in a CSV cell.
import { Timestamp, GeoPoint, DocumentReference, Firestore } from 'firebase-admin/firestore';

const FIELD_TYPES = [
  'string', 'number', 'boolean', 'null', 'timestamp', 'geopoint',
  'reference', 'bytes', 'array', 'map', 'any',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A Firestore value in a JSON-safe, lossless-enough form. */
export type PValue =
  | { t: 'string'; v: string }
  | { t: 'number'; v: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { t: 'boolean'; v: boolean }
  | { t: 'null' }
  | { t: 'timestamp'; v: { s: number; n: number } }
  | { t: 'geopoint'; v: { lat: number; lng: number } }
  | { t: 'reference'; v: string }
  | { t: 'bytes'; v: string } // base64
  | { t: 'array'; v: PValue[] }
  | { t: 'map'; v: Record<string, PValue> };

export class CellError extends Error {}

// ---------- Firestore <-> PValue ----------

export function fromFirestore(value: unknown): PValue {
  if (value === null || value === undefined) return { t: 'null' };
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { t: 'number', v: value };
    return { t: 'number', v: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
  }
  if (value instanceof Timestamp) return { t: 'timestamp', v: { s: value.seconds, n: value.nanoseconds } };
  if (value instanceof GeoPoint) return { t: 'geopoint', v: { lat: value.latitude, lng: value.longitude } };
  if (value instanceof DocumentReference) return { t: 'reference', v: value.path };
  if (value instanceof Uint8Array) return { t: 'bytes', v: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return { t: 'array', v: value.map(fromFirestore) };
  if (typeof value === 'object') {
    const out: Record<string, PValue> = {};
    for (const [k, v] of Object.entries(value as object)) out[k] = fromFirestore(v);
    return { t: 'map', v: out };
  }
  throw new Error(`Unsupported Firestore value: ${String(value)}`);
}

export function toFirestore(p: PValue, db: Firestore): unknown {
  switch (p.t) {
    case 'string': case 'boolean': return p.v;
    case 'number': return typeof p.v === 'number' ? p.v : Number(p.v);
    case 'null': return null;
    case 'timestamp': return new Timestamp(p.v.s, p.v.n);
    case 'geopoint': return new GeoPoint(p.v.lat, p.v.lng);
    case 'reference': return db.doc(p.v);
    case 'bytes': return Buffer.from(p.v, 'base64');
    case 'array': return p.v.map((x) => toFirestore(x, db));
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.v)) out[k] = toFirestore(v, db);
      return out;
    }
  }
}

// ---------- Timestamps ----------

function timestampToIso({ s, n }: { s: number; n: number }): string {
  const base = new Date(s * 1000).toISOString().slice(0, 19); // 2024-01-02T03:04:05
  if (n === 0) return `${base}Z`;
  const frac = String(n).padStart(9, '0');
  // Milliseconds when that's exact, otherwise full nanosecond precision.
  return `${base}.${n % 1_000_000 === 0 ? frac.slice(0, 3) : frac}Z`;
}

function isoToTimestamp(text: string): { s: number; n: number } {
  const m = /^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim());
  const ms = Date.parse(text);
  if (!m || Number.isNaN(ms)) throw new CellError(`"${text}" is not a valid date/time (use ISO 8601, e.g. 2024-05-01T12:00:00Z)`);
  const frac = m[2] ?? '';
  const n = Number(frac.padEnd(9, '0'));
  const s = Math.floor(ms / 1000);
  return { s, n: frac ? n : (ms - s * 1000) * 1_000_000 };
}

// ---------- Geopoints and references ----------

function checkGeo(lat: number, lng: number, text: string): { lat: number; lng: number } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new CellError(`"${text}" is not a geopoint (use "lat, lng")`);
  if (lat < -90 || lat > 90) throw new CellError(`"${text}": latitude must be between -90 and 90`);
  if (lng < -180 || lng > 180) throw new CellError(`"${text}": longitude must be between -180 and 180`);
  return { lat, lng };
}

/** Validate a document path ("users/abc", "users/abc/posts/1"); a leading "/" is dropped. */
function checkRefPath(text: string): string {
  const path = text.trim().replace(/^\/+/, '');
  const parts = path.split('/');
  if (path === '' || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new CellError(`"${text}" is not a document path (use <collection>/<id>)`);
  }
  if (parts.length % 2 !== 0) {
    throw new CellError(`"${text}" points to a collection, not a document (use <collection>/<id>)`);
  }
  return path;
}

// ---------- Extended JSON (for maps, arrays and `any` columns) ----------
// Plain JSON for primitives; special types become tagged objects:
//   {"$timestamp": "2024-01-01T00:00:00Z"}  {"$ref": "users/abc"}
//   {"$geo": [lat, lng]}                     {"$bytes": "base64..."}   {"$number": "NaN"}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function toEJson(p: PValue): Json {
  switch (p.t) {
    case 'string': case 'boolean': return p.v;
    case 'number': return typeof p.v === 'number' ? p.v : { $number: p.v };
    case 'null': return null;
    case 'timestamp': return { $timestamp: timestampToIso(p.v) };
    case 'geopoint': return { $geo: [p.v.lat, p.v.lng] };
    case 'reference': return { $ref: p.v };
    case 'bytes': return { $bytes: p.v };
    case 'array': return p.v.map(toEJson);
    case 'map': {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(p.v)) out[k] = toEJson(v);
      return out;
    }
  }
}

function fromEJson(j: Json): PValue {
  if (j === null) return { t: 'null' };
  if (typeof j === 'string') return { t: 'string', v: j };
  if (typeof j === 'boolean') return { t: 'boolean', v: j };
  if (typeof j === 'number') return { t: 'number', v: j };
  if (Array.isArray(j)) return { t: 'array', v: j.map(fromEJson) };
  const keys = Object.keys(j);
  if (keys.length === 1) {
    const [k] = keys;
    const v = j[k];
    if (k === '$timestamp' && typeof v === 'string') return { t: 'timestamp', v: isoToTimestamp(v) };
    if (k === '$ref' && typeof v === 'string') return { t: 'reference', v: checkRefPath(v) };
    if (k === '$bytes' && typeof v === 'string') return { t: 'bytes', v };
    if (k === '$number' && (v === 'NaN' || v === 'Infinity' || v === '-Infinity')) return { t: 'number', v };
    if (k === '$geo' && Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) {
      return { t: 'geopoint', v: checkGeo(v[0] as number, v[1] as number, JSON.stringify(j)) };
    }
  }
  const out: Record<string, PValue> = {};
  for (const [k, v] of Object.entries(j)) out[k] = fromEJson(v);
  return { t: 'map', v: out };
}

// ---------- PValue <-> cell text ----------

/** Literal cell text meaning "empty string" (an empty cell means "field not present"). */
const EMPTY_STRING_CELL = '""';

export function encodeCell(p: PValue | undefined, colType: FieldType): string {
  if (p === undefined) return '';
  if (colType === 'any') return encodeGuessed(p);
  if (p.t !== colType) {
    // `null` is allowed in any typed column; anything else mismatched falls back to EJSON.
    if (p.t === 'null') return 'null';
    return JSON.stringify(toEJson(p));
  }
  switch (p.t) {
    case 'string': return p.v === '' ? EMPTY_STRING_CELL : p.v;
    case 'number': return String(p.v);
    case 'boolean': return String(p.v);
    case 'null': return 'null';
    case 'timestamp': return timestampToIso(p.v);
    case 'geopoint': return `${p.v.lat}, ${p.v.lng}`;
    case 'reference': return p.v;
    case 'bytes': return p.v;
    case 'array': case 'map': return JSON.stringify(toEJson(p));
  }
}

/** Parse cell text. Returns undefined for an empty cell (field absent). */
export function decodeCell(text: string, colType: FieldType): PValue | undefined {
  if (text === '') return undefined;
  if (colType === 'string') return { t: 'string', v: text === EMPTY_STRING_CELL ? '' : text };
  if (colType === 'any') return guessCell(text);
  if (text.trim() === 'null') return { t: 'null' };
  const s = text.trim();
  switch (colType) {
    case 'number': {
      if (s === 'NaN' || s === 'Infinity' || s === '-Infinity') return { t: 'number', v: s };
      const n = Number(s);
      if (s === '' || Number.isNaN(n)) throw new CellError(`"${text}" is not a number`);
      return { t: 'number', v: n };
    }
    case 'boolean': {
      const l = s.toLowerCase();
      if (l === 'true') return { t: 'boolean', v: true };
      if (l === 'false') return { t: 'boolean', v: false };
      throw new CellError(`"${text}" is not true/false`);
    }
    case 'null':
      throw new CellError(`"${text}" is not null`);
    case 'timestamp':
      return { t: 'timestamp', v: isoToTimestamp(s) };
    case 'geopoint': {
      const parts = s.split(',').map((x) => x.trim());
      if (parts.length !== 2 || parts.some((x) => x === '')) throw new CellError(`"${text}" is not a geopoint (use "lat, lng")`);
      return { t: 'geopoint', v: checkGeo(Number(parts[0]), Number(parts[1]), text) };
    }
    case 'reference': return { t: 'reference', v: checkRefPath(s) };
    case 'bytes': return { t: 'bytes', v: s };
    case 'array': case 'map': {
      let parsed: Json;
      try {
        parsed = JSON.parse(s);
      } catch {
        throw new CellError(`"${text}" is not valid JSON for a ${colType} column`);
      }
      const p = fromEJson(parsed);
      if (p.t !== colType) throw new CellError(`expected a JSON ${colType === 'array' ? 'array' : 'object'}, got ${p.t}`);
      return p;
    }
  }
}

// ---------- Column headers ----------

export interface Column { field: string; type: FieldType }

export function parseHeader(h: string): Column {
  const i = h.lastIndexOf(':');
  if (i > 0) {
    const t = h.slice(i + 1).trim().toLowerCase();
    if ((FIELD_TYPES as readonly string[]).includes(t)) return { field: h.slice(0, i).trim(), type: t as FieldType };
  }
  return { field: h.trim(), type: 'string' };
}

/**
 * Headers always carry their type (`name:string`), so every column shows how it's stored.
 * `bare` keeps a header the user wrote without a type, so its values are still guessed one by one.
 */
export function formatHeader(c: Column, bare = false): string {
  return bare ? c.field : `${c.field}:${c.type}`;
}

/** Pick a column type from the set of value types seen for a field. */
export function inferColumnType(types: Set<PValue['t']>): FieldType {
  const real = [...types].filter((t) => t !== 'null');
  if (real.length === 0) return types.size ? 'null' : 'string';
  if (real.length === 1) {
    // A string column can't hold a literal null distinguishable from the text "null".
    if (real[0] === 'string' && types.has('null')) return 'any';
    return real[0];
  }
  return 'any';
}

// ---------- Columns without a type: each value is read as what it clearly is ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Read a cell from a column with no `:type`: true/false (any case) → boolean, plain numbers →
 * number, ISO dates → timestamp, JSON objects/arrays → map/array, `null` → null, anything else →
 * text as typed. Numbers with leading zeros or a "+" ("0123", "+8490…") stay text.
 */
export function guessCell(text: string): PValue | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  if (s === EMPTY_STRING_CELL) return { t: 'string', v: '' };
  if (/^(true|false)$/i.test(s)) return { t: 'boolean', v: s.toLowerCase() === 'true' };
  if (s === 'null') return { t: 'null' };
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return { t: 'number', v: Number(s) };
  if (ISO_DATE.test(s) && !Number.isNaN(Date.parse(s))) return { t: 'timestamp', v: isoToTimestamp(s) };
  if (s.startsWith('{') || s.startsWith('[') || (s.startsWith('"') && s.endsWith('"'))) {
    // JSON: objects/arrays (and tagged values like {"$timestamp": …}), or a quoted string —
    // quotes are how text that would otherwise be misread is written ("42", "true").
    let parsed: Json | undefined;
    try { parsed = JSON.parse(s); } catch { /* not JSON: text */ }
    // Valid JSON with a bad tagged value ({"$geo": [100, 0]}) is an error, not text.
    if (parsed !== undefined) return fromEJson(parsed);
  }
  return { t: 'string', v: text };
}

/** Write a value so that guessCell reads it back as the same value. */
export function encodeGuessed(p: PValue | undefined): string {
  if (p === undefined) return '';
  switch (p.t) {
    case 'string': {
      // Plain text as typed — unless it would be read back as something else ("42", "true", "").
      const back = guessCell(p.v);
      return back?.t === 'string' && back.v === p.v ? p.v : JSON.stringify(p.v);
    }
    case 'number': return typeof p.v === 'number' ? String(p.v) : JSON.stringify(toEJson(p));
    case 'boolean': return String(p.v);
    case 'null': return 'null';
    case 'timestamp': return timestampToIso(p.v);
    default: return JSON.stringify(toEJson(p));
  }
}
