//! The rebuild of a type's indexes when `Register` changes them on a type
//! that has documents (A81, RK27).

use std::{ops::ControlFlow, time::Instant};

use doric_bundle::ContractError;
use doric_sqlite::{KeyRange, WriteTxn};
use prost_reflect::DescriptorPool;

use super::{REBUILD_DOCUMENTS, Rebuilt};
use crate::{
    cache::Staged,
    commit::transaction::{detailed, internal},
    documents::stored_header,
    keys::{self, Element},
    layout::{self, DocumentHeader, IndexDeclaration, TypeDeclaration},
    schema,
};

/// The indexes `declared` changes from `stored`, compared by name: the names
/// of `stored`'s indexes that `declared` changes or drops, and `declared`'s
/// new or changed indexes, in its order. Both empty for a reorder.
fn changes<'a>(
    stored: &'a TypeDeclaration,
    declared: &'a TypeDeclaration,
) -> (Vec<&'a str>, Vec<&'a IndexDeclaration>) {
    let clear = stored
        .indexes
        .iter()
        .filter(|old| !declared.indexes.contains(old))
        .map(|old| old.name.as_str())
        .collect();
    let build = declared
        .indexes
        .iter()
        .filter(|new| !stored.indexes.contains(new))
        .collect();
    (clear, build)
}

/// Rebuilds the indexes of `type_id` when `declared` changes them from
/// `stored` other than by order, timed; `None` for a reorder or a type with
/// no documents. Each header it rewrites leaves the cache through `staged`.
///
/// # Errors
///
/// The errors of [`rebuild`].
pub(super) fn rebuilt(
    txn: &mut dyn WriteTxn,
    staged: &mut Staged,
    bundle: &str,
    type_id: &str,
    pool: &DescriptorPool,
    stored: &TypeDeclaration,
    declared: &TypeDeclaration,
) -> Result<Option<Rebuilt>, ContractError> {
    let (clear, build) = changes(stored, declared);
    if clear.is_empty() && build.is_empty() {
        return Ok(None);
    }
    let started = Instant::now();
    let documents = rebuild(txn, staged, bundle, type_id, pool, stored, declared)?;
    Ok((documents > 0).then(|| Rebuilt {
        type_id: type_id.to_owned(),
        documents,
        elapsed: started.elapsed(),
    }))
}

/// Rebuilds, in `txn`, the indexes of the type `type_id` of `bundle` from
/// `stored`, its stored declaration, to `declared`, the one being
/// registered; answers the number of the type's documents, at most
/// [`REBUILD_DOCUMENTS`](super::REBUILD_DOCUMENTS).
///
/// Counts the type's documents before it decodes any. Then, in `txn`: every
/// key of an index of `stored` that `declared` changes or drops is deleted;
/// each document, in id key order, is decoded with `pool` as
/// `declared.message_type` only when `declared` has a new or changed index,
/// and gains the keys of each new or changed index; each header's
/// `index_keys` is rewritten in `declared`'s index order, an unchanged
/// index keeping its stored keys, and keeps its revision and `updated_at`;
/// it is forgotten in `staged`. It holds one stored value in memory at a
/// time. It writes no declaration.
///
/// # Errors
///
/// Every error leaves `txn` to be rolled back by the caller:
/// `limit_exceeded` (`details.limit` `"rebuild"`) for more than
/// `REBUILD_DOCUMENTS` documents, before any decode; `unique_conflict`
/// (details `{type, index, ids}`, `ids` the key's holder then the other
/// document, in id key order) for the first new or changed unique index, in
/// `declared`'s order, on which two documents share a key;
/// [`schema::json_form`](crate::schema::json_form)'s `invalid_input` as it
/// is; the errors of [`schema::index_values`](crate::schema::index_values)
/// and [`layout::index`](crate::layout::index); `internal` for a header that
/// does not decode, a missing chunk, or a `message_type` absent from
/// `pool`; the errors of `txn`.
pub(super) fn rebuild(
    txn: &mut dyn WriteTxn,
    staged: &mut Staged,
    bundle: &str,
    type_id: &str,
    pool: &DescriptorPool,
    stored: &TypeDeclaration,
    declared: &TypeDeclaration,
) -> Result<usize, ContractError> {
    let ids = document_ids(txn, bundle, type_id)?;
    let (clear, build) = changes(stored, declared);
    for name in clear {
        let range = layout::under(bundle, &["idx", type_id, name]);
        txn.clear_range(&range.start, &range.end)?;
    }
    let message = (!build.is_empty())
        .then(|| {
            pool.get_message_by_name(&declared.message_type)
                .ok_or_else(|| {
                    internal(format!(
                        "The registered set has no message {}.",
                        declared.message_type
                    ))
                })
        })
        .transpose()?;
    let mut conflict: Option<(usize, ContractError)> = None;
    for id in &ids {
        let mut header = stored_header(txn, bundle, type_id, id)?.ok_or_else(|| {
            internal(format!(
                "The header of the document \"{id}\" of \"{type_id}\" is missing."
            ))
        })?;
        let built = match &message {
            Some(message) => {
                let value = stored_value(txn, bundle, (type_id, id), &header)?;
                let json = schema::json_form(message, &value)?;
                drop(value);
                built_keys(txn, bundle, (type_id, id), &json, &build, &mut conflict)?
            }
            None => Vec::new(),
        };
        if conflict.is_some() {
            continue;
        }
        let mut built = built.into_iter();
        let mut index_keys = Vec::new();
        for index in &declared.indexes {
            if build.contains(&index) {
                index_keys.extend(built.next());
            } else {
                let prefix = layout::index(type_id, &index.name, &[], None)?;
                let kept = header
                    .index_keys
                    .iter()
                    .filter(|key| key.starts_with(&prefix));
                index_keys.extend(kept.cloned());
            }
        }
        header.index_keys = index_keys;
        let document = layout::document(bundle, type_id, id);
        txn.put(&document, &prost::Message::encode_to_vec(&header))?;
        staged.forget(document);
    }
    match conflict {
        Some((_, error)) => Err(error),
        None => Ok(ids.len()),
    }
}

/// The ids of `type_id`'s documents, in id key order, read keys only.
///
/// # Errors
///
/// `limit_exceeded` (`details.limit` `"rebuild"`) for more than
/// [`REBUILD_DOCUMENTS`]; `internal` for a key that does not decode to an id;
/// the errors of `txn`.
fn document_ids(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    type_id: &str,
) -> Result<Vec<String>, ContractError> {
    let range = KeyRange {
        keys_only: true,
        ..layout::under(bundle, &["doc", type_id])
    };
    let mut keys = Vec::new();
    txn.range(&range, &mut |entry| {
        keys.push(entry.key[range.start.len()..].to_vec());
        if keys.len() > REBUILD_DOCUMENTS {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    if keys.len() > REBUILD_DOCUMENTS {
        return Err(doric_sqlite::refusal(
            "limit_exceeded",
            format!(
                "The type \"{type_id}\" has more than {REBUILD_DOCUMENTS} documents to rebuild the indexes of."
            ),
            "limit",
            "rebuild".into(),
        ));
    }
    keys.into_iter()
        .map(|key| match keys::decode(&key).ok().as_deref() {
            Some([Element::String(id)]) => Ok(id.clone()),
            _ => Err(internal(format!(
                "A document key of \"{type_id}\" holds no id."
            ))),
        })
        .collect()
}

/// The keys of the indexes `build` for the document `id` whose JSON form is
/// `json`, each written to the store; a unique key another document holds is
/// written to `conflict` instead when its index comes before the one already
/// there, in `build`'s order.
///
/// # Errors
///
/// The errors of [`schema::index_values`], [`layout::index`] and `txn`.
fn built_keys(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    (type_id, id): (&str, &str),
    json: &serde_json::Value,
    build: &[&IndexDeclaration],
    conflict: &mut Option<(usize, ContractError)>,
) -> Result<Vec<Vec<u8>>, ContractError> {
    let mut keys = Vec::with_capacity(build.len());
    for (position, index) in build.iter().enumerate() {
        let values = schema::index_values(json, &index.fields)?;
        let key = layout::index(type_id, &index.name, &values, (!index.unique).then_some(id))?;
        let stored = layout::prefixed(bundle, &key);
        if index.unique {
            if let Some((holder, _)) = txn.get(&stored)?
                && holder != id.as_bytes()
            {
                if conflict.as_ref().is_none_or(|(first, _)| position < *first) {
                    let holder = String::from_utf8_lossy(&holder).into_owned();
                    *conflict = Some((position, unique_conflict(type_id, &index.name, holder, id)));
                }
                continue;
            }
            txn.put(&stored, id.as_bytes())?;
        } else {
            txn.put(&stored, b"")?;
        }
        keys.push(key);
    }
    Ok(keys)
}

/// The whole stored value of `(type_id, id)`, whose header is `header`: the
/// header's bytes, then each chunk's.
///
/// # Errors
///
/// `internal` for a missing chunk; the errors of `txn`.
fn stored_value(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    (type_id, id): (&str, &str),
    header: &DocumentHeader,
) -> Result<Vec<u8>, ContractError> {
    let mut value = header.chunk.clone();
    for n in 1..=header.chunk_count {
        let (bytes, _) = txn
            .get(&layout::chunk(bundle, type_id, id, n))?
            .ok_or_else(|| {
                internal(format!(
                    "The chunk {n} of the document \"{id}\" of \"{type_id}\" is missing."
                ))
            })?;
        value.extend_from_slice(&bytes);
    }
    Ok(value)
}

/// `unique_conflict` (details `{type, index, ids}`) for the documents
/// `holder` and `id` sharing a key of the unique index `index`.
fn unique_conflict(type_id: &str, index: &str, holder: String, id: &str) -> ContractError {
    let ids = prost_types::ListValue {
        values: vec![holder.into(), id.into()],
    };
    detailed(
        "unique_conflict",
        format!("Two documents of \"{type_id}\" share a key of the new unique index \"{index}\"."),
        [
            ("type", type_id.into()),
            ("index", index.into()),
            (
                "ids",
                prost_types::Value {
                    kind: Some(prost_types::value::Kind::ListValue(ids)),
                },
            ),
        ],
    )
}
