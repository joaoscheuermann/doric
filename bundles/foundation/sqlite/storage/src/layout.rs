//! The keys of a bundle's schema and type records (spec "The layout"): each is
//! the bundle's prefix, the UTF-8 bytes of `<bundle>/`, followed by a tuple
//! encoded by [`crate::keys`], and the records' messages, `doric.storage.layout.v1`.
//! Every tuple of a schema, type, document or chunk key holds only strings and
//! whole numbers, which always encode, so none of these keys fails; an index
//! key holds a document's values, and [`index`] may refuse it.

use doric_bundle::ContractError;
pub use records::{
    DocumentHeader, IndexDeclaration, StreamEntryHeader, StreamHead, TruncationMark,
    TypeDeclaration,
};

use crate::keys::{self, Element};

/// The most UTF-8 bytes of a document id.
pub const ID_BYTES: usize = 512;
/// The most bytes of a value in one record: `DocumentHeader.chunk` and each
/// `("doc.chunk", type, id, n)` hold at most this many.
pub const CHUNK_BYTES: usize = 983_040;
/// The most bytes of one index key, measured without the bundle's prefix, as
/// `DocumentHeader.index_keys` stores it.
pub const INDEX_KEY_BYTES: usize = 2_048;

/// Checks a document's address for the bundle `owner` before any I/O, in this
/// order: [`schema::owned`](crate::schema::owned)`(type_id, owner)`, then the
/// id's length. An empty id is valid.
///
/// # Errors
///
/// The errors of `owned`: `invalid_input` (detail `type`) for a type id of
/// 0 or more than [`TYPE_ID_BYTES`](crate::schema::TYPE_ID_BYTES) bytes,
/// then `not_owner` (detail `type`) for a type of another namespace; then
/// `invalid_input` (detail `id`, the id) for an id over [`ID_BYTES`] bytes.
pub fn checked(owner: &str, type_id: &str, id: &str) -> Result<(), ContractError> {
    crate::schema::owned(type_id, owner)?;
    if id.len() > ID_BYTES {
        return Err(doric_sqlite::refusal(
            "invalid_input",
            format!(
                "A document id holds at most {ID_BYTES} bytes; this one holds {}.",
                id.len()
            ),
            "id",
            id.into(),
        ));
    }
    Ok(())
}

/// `<bundle>/("doc", type, id)`: the key of the document's [`DocumentHeader`].
///
/// It sorts under [`under`]`(bundle, &["doc", type_id])`, and two different
/// `(type_id, id)` give two different keys.
pub fn document(bundle: &str, type_id: &str, id: &str) -> Vec<u8> {
    key(bundle, &["doc", type_id, id])
}

/// `<bundle>/("doc.chunk", type, id, n)`, `n` a number element: the key of the
/// document's `n`th chunk after the header's, for `n` from 1 to the header's
/// `chunk_count`.
///
/// The chunks of one document sort by `n`, under
/// [`under`]`(bundle, &["doc.chunk", type_id, id])`, and outside
/// [`under`]`(bundle, &["doc"])`. `n` is 1 or more; 0 is no record of the
/// layout.
pub fn chunk(bundle: &str, type_id: &str, id: &str, n: u32) -> Vec<u8> {
    let tuple = [
        Element::String("doc.chunk".to_owned()),
        Element::String(type_id.to_owned()),
        Element::String(id.to_owned()),
        Element::Number(f64::from(n)),
    ];
    keys::key(bundle, &tuple).expect("a tuple of strings and a whole number always encodes")
}

/// `("idx", type, name, …values[, id])` without the bundle's prefix, the form
/// `DocumentHeader.index_keys` stores: the key of the index `name` of
/// `type_id` for a document whose index values are `values`, in the index's
/// field order. A unique index's key leaves out the id (`id` `None`), so two
/// documents with equal values have one key; a non-unique index's key ends
/// with the id (`id` `Some`).
///
/// [`prefixed`] makes it a key of the store.
///
/// # Errors
///
/// `invalid_index_value` for a number of `values` that is not finite (as
/// [`keys::encode`]); `limit_exceeded` (`details.limit` `"indexKey"`) for a
/// key of more than [`INDEX_KEY_BYTES`] bytes.
pub fn index(
    type_id: &str,
    name: &str,
    values: &[Element],
    id: Option<&str>,
) -> Result<Vec<u8>, ContractError> {
    let mut tuple = Vec::with_capacity(values.len() + 4);
    tuple.extend(["idx", type_id, name].map(|string| Element::String(string.to_owned())));
    tuple.extend_from_slice(values);
    if let Some(id) = id {
        tuple.push(Element::String(id.to_owned()));
    }
    let key = keys::encode(&tuple)?;
    if key.len() > INDEX_KEY_BYTES {
        return Err(doric_sqlite::refusal(
            "limit_exceeded",
            format!(
                "The index key of \"{name}\" of \"{type_id}\" holds {} bytes; the limit is {INDEX_KEY_BYTES}.",
                key.len()
            ),
            "limit",
            "indexKey".into(),
        ));
    }
    Ok(key)
}

/// `key` under `bundle`'s prefix: the UTF-8 bytes of `<bundle>/`, then `key`.
/// `prefixed(bundle, &index(…)?)` is the store's key of an index key.
pub fn prefixed(bundle: &str, key: &[u8]) -> Vec<u8> {
    [format!("{bundle}/").as_bytes(), key].concat()
}

/// The generated messages of `doric.storage.layout.v1`.
#[allow(clippy::all)]
mod records {
    include!(concat!(env!("OUT_DIR"), "/doric.storage.layout.v1.rs"));
}

/// `<bundle>/("schema", hash)`: the key of a descriptor set the bundle
/// registered, whose `hash` is the lowercase SHA-256 hex of its bytes.
///
/// It is the prefix followed by the tuple's encoding, so it sorts under
/// [`under`]`(bundle, &["schema"])`, and two different hashes give two
/// different keys.
pub fn schema(bundle: &str, hash: &str) -> Vec<u8> {
    key(bundle, &["schema", hash])
}

/// `<bundle>/("schema.current")`: the key whose value is the hash of the last
/// descriptor set the bundle registered, in UTF-8.
///
/// It is outside [`under`]`(bundle, &["schema"])`: `"schema.current"` is
/// another first element than `"schema"`.
pub fn current(bundle: &str) -> Vec<u8> {
    key(bundle, &["schema.current"])
}

/// `<bundle>/("type", type)`: the key of the type's [`TypeDeclaration`].
///
/// It sorts under [`under`]`(bundle, &["type"])`.
pub fn declaration(bundle: &str, type_id: &str) -> Vec<u8> {
    key(bundle, &["type", type_id])
}

/// The keys under `bundle`'s prefix whose tuple starts with the strings of
/// `tuple` (`["schema"]`, `["type"]`, `["doc", type]`): `[key, end(key))`,
/// where `key` is the prefix followed by `tuple`'s encoding, in key order,
/// values included.
///
/// The range holds every key whose tuple extends `tuple` and no other: no key
/// of another bundle, and no key whose tuple only shares a first element's
/// beginning (`("schema.current")` is not under `["schema"]`).
pub fn under(bundle: &str, tuple: &[&str]) -> doric_sqlite::KeyRange {
    let start = key(bundle, tuple);
    doric_sqlite::KeyRange {
        end: end(&start),
        start,
        ..doric_sqlite::KeyRange::default()
    }
}

/// `<bundle>/("stream.head", stream)`: the key of the stream's
/// [`StreamHead`].
///
/// It sorts under [`under`]`(bundle, &["stream.head"])`, and two different
/// streams give two different keys.
pub fn head(bundle: &str, stream: &str) -> Vec<u8> {
    key(bundle, &["stream.head", stream])
}

/// `<bundle>/("stream.entry", stream, sequence)`, `sequence` a number
/// element: the key of the entry's [`StreamEntryHeader`].
///
/// The entries of one stream sort by `sequence`, under
/// [`under`]`(bundle, &["stream.entry", stream])`.
pub fn entry(bundle: &str, stream: &str, sequence: u32) -> Vec<u8> {
    numbered(bundle, "stream.entry", stream, &[sequence])
}

/// `<bundle>/("stream.chunk", stream, sequence, n)`, `sequence` and `n`
/// number elements: the key of the entry's `n`th chunk after its header's,
/// for `n` from 1 to the header's `chunk_count`.
///
/// The chunks of one entry sort by `n`, under
/// [`under`]`(bundle, &["stream.chunk", stream])`.
pub fn entry_chunk(bundle: &str, stream: &str, sequence: u32, n: u32) -> Vec<u8> {
    numbered(bundle, "stream.chunk", stream, &[sequence, n])
}

/// `<bundle>/("stream.mark", stream)` followed by `position`, a whole number
/// below 2^53, as 8 bytes big-endian: the key of the [`TruncationMark`] the
/// commit at `position` wrote.
///
/// The marks of one stream sort by position, under
/// [`under`]`(bundle, &["stream.mark", stream])`.
pub fn mark(bundle: &str, stream: &str, position: f64) -> Vec<u8> {
    // A position is a whole number below 2^53, which converts exactly.
    let position = position as u64;
    [
        key(bundle, &["stream.mark", stream]),
        position.to_be_bytes().to_vec(),
    ]
    .concat()
}

/// The keys of `kind` (`"stream.entry"` or `"stream.chunk"`) of `stream`
/// under `bundle`'s prefix whose sequence is `sequence` or more, in key
/// order, up to the end of the stream's keys of that kind.
pub fn entries_from(
    bundle: &str,
    kind: &str,
    stream: &str,
    sequence: u32,
) -> doric_sqlite::KeyRange {
    doric_sqlite::KeyRange {
        start: numbered(bundle, kind, stream, &[sequence]),
        end: end(&key(bundle, &[kind, stream])),
        ..doric_sqlite::KeyRange::default()
    }
}

/// `bundle/` followed by the tuple `(kind, stream, …numbers)`.
fn numbered(bundle: &str, kind: &str, stream: &str, numbers: &[u32]) -> Vec<u8> {
    let mut tuple = vec![
        Element::String(kind.to_owned()),
        Element::String(stream.to_owned()),
    ];
    tuple.extend(numbers.iter().map(|&n| Element::Number(f64::from(n))));
    keys::key(bundle, &tuple).expect("a tuple of strings and whole numbers always encodes")
}

/// `start` followed by `0xFF`: above every key whose tuple extends `start`'s,
/// since every encoded element starts with a byte below `0xFF`, and above
/// `start` itself.
fn end(start: &[u8]) -> Vec<u8> {
    let mut end = start.to_vec();
    end.push(0xFF);
    end
}

/// `bundle/` followed by the tuple of `strings`.
fn key(bundle: &str, strings: &[&str]) -> Vec<u8> {
    let tuple: Vec<Element> = strings
        .iter()
        .map(|&string| Element::String(string.to_owned()))
        .collect();
    keys::key(bundle, &tuple).expect("a tuple of strings always encodes")
}

#[cfg(test)]
mod tests;
