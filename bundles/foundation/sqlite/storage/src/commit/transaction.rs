//! The two transactions of [`super::apply`]: the read that computes each put's
//! index keys ([`plan`]), and the write that applies the batch ([`write`]).

use std::collections::BTreeMap;

use doric_bundle::ContractError;
use doric_sqlite::{ReadTxn, WriteTxn};

use super::{Entry, Items, iso};
use crate::{
    cache::{Header, Headers, Staged},
    commit::Clock,
    documents::unknown_type,
    layout::{self, CHUNK_BYTES, DocumentHeader, TypeDeclaration},
    register::stored_declaration,
    schema::{self, Pools},
};

/// A put's declaration as the read found it, and the index keys computed with
/// it.
#[derive(Debug)]
pub(super) struct Plan {
    declaration: TypeDeclaration,
    keys: Vec<IndexKey>,
}

/// One index key of a put, without the bundle's prefix.
#[derive(Debug)]
struct IndexKey {
    key: Vec<u8>,
    index: String,
    unique: bool,
}

/// A put of a batch: its type, id and value.
type Put<'a> = (&'a str, &'a str, &'a [u8]);

/// The plan of each put of `items`, in batch order, read in one transaction:
/// each item's declaration in batch order, then, for a put, its index keys.
///
/// # Errors
///
/// As [`super::apply`]'s read transaction.
pub(super) fn plan(
    txn: &mut dyn ReadTxn,
    pools: &Pools,
    items: &Items,
) -> Result<Vec<Plan>, ContractError> {
    let bundle = &items.bundle;
    let mut declarations = BTreeMap::new();
    let mut plans = Vec::new();
    for entry in &items.entries {
        let (type_id, put) = match entry {
            Entry::Expect { type_id, .. } | Entry::Delete { type_id, .. } => (type_id, None),
            Entry::Put { type_id, id, value } => (type_id, Some((id, value))),
            Entry::DropStream { .. } | Entry::Truncate { .. } | Entry::Append { .. } => continue,
        };
        let declaration = declared(txn, &mut declarations, bundle, type_id)?;
        if let Some((id, value)) = put {
            let keys = index_keys(txn, pools, bundle, &declaration, (type_id, id, value))?;
            plans.push(Plan { declaration, keys });
        }
    }
    Ok(plans)
}

/// Applies `items` in one write transaction, with the index keys of `plans`,
/// recomputed for a put whose declaration changed since [`plan`], reading and
/// writing headers through `headers` ([`Headers::begin`]), then its stream
/// items ([`super::streams::write`]), each entry with the puts' `updated_at`
/// as `created_at`; the cache takes the transaction's headers and stream
/// heads only once it has committed.
///
/// # Errors
///
/// As [`super::apply`]'s write transaction.
pub(super) fn write(
    txn: &mut dyn WriteTxn,
    clock: &Clock,
    pools: &Pools,
    headers: &Headers,
    items: &Items,
    mut plans: Vec<Plan>,
) -> Result<(), ContractError> {
    let mut staged = headers.begin(txn);
    let bundle = &items.bundle;
    let puts: Vec<Put<'_>> = items
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Put { type_id, id, value } => Some((type_id.as_str(), id.as_str(), &value[..])),
            _ => None,
        })
        .collect();

    let mut declarations = BTreeMap::new();
    for (put, plan) in puts.iter().zip(&mut plans) {
        let declaration = declared(txn, &mut declarations, bundle, put.0)?;
        if declaration != plan.declaration {
            plan.keys = index_keys(txn, pools, bundle, &declaration, *put)?;
            plan.declaration = declaration;
        }
    }

    for entry in &items.entries {
        if let Entry::Expect {
            type_id,
            id,
            revision,
        } = entry
        {
            let actual = staged
                .header(txn, &layout::document(bundle, type_id, id))?
                .map_or(0, |header| header.revision);
            if actual != *revision {
                return Err(detailed(
                    "revision_conflict",
                    format!(
                        "The document \"{id}\" of \"{type_id}\" is at revision {actual}, not {revision}."
                    ),
                    [
                        ("type", type_id.as_str().into()),
                        ("id", id.as_str().into()),
                        ("expected", f64::from(*revision).into()),
                        ("actual", f64::from(actual).into()),
                    ],
                ));
            }
        }
    }

    let updated_at = iso(clock.tick(clock.now()));
    for entry in &items.entries {
        let Entry::Delete { type_id, id } = entry else {
            continue;
        };
        let document = layout::document(bundle, type_id, id);
        if let Some(header) = staged.header(txn, &document)? {
            for n in 1..=header.chunk_count {
                txn.delete(&layout::chunk(bundle, type_id, id, n))?;
            }
            for key in &header.index_keys {
                txn.delete(&layout::prefixed(bundle, key))?;
            }
            txn.delete(&document)?;
            staged.forget(document);
        }
    }

    for (put, plan) in puts.into_iter().zip(&plans) {
        put_one(txn, &mut staged, bundle, put, &plan.keys, &updated_at)?;
    }
    super::streams::write(txn, &mut staged, bundle, &items.entries, &updated_at)?;
    staged.finish(txn);
    Ok(())
}

/// Writes the put `put` with its index keys `keys`: its header, its chunks
/// and its keys, removing the chunks and keys of its last header it no longer
/// has; reads its last header from `staged` and stages the new one there.
///
/// # Errors
///
/// `unique_conflict` for a unique key another document holds; `internal` for
/// a stored header that does not decode or a revision past `u32::MAX`; the
/// errors of the transaction.
fn put_one(
    txn: &mut dyn WriteTxn,
    staged: &mut Staged,
    bundle: &str,
    (type_id, id, value): Put<'_>,
    keys: &[IndexKey],
    updated_at: &str,
) -> Result<(), ContractError> {
    let document = layout::document(bundle, type_id, id);
    let old = staged.header(txn, &document)?;
    for key in keys.iter().filter(|key| key.unique) {
        if let Some((holder, _)) = txn.get(&layout::prefixed(bundle, &key.key))?
            && holder != id.as_bytes()
        {
            return Err(detailed(
                "unique_conflict",
                format!(
                    "Another document of \"{type_id}\" holds this key of the unique index \"{}\".",
                    key.index
                ),
                [
                    ("type", type_id.into()),
                    ("index", key.index.as_str().into()),
                ],
            ));
        }
    }
    let revision = old
        .as_ref()
        .map_or(0, |header| header.revision)
        .checked_add(1)
        .ok_or_else(|| {
            ContractError::new(
                "internal",
                format!(
                    "The document \"{id}\" of \"{type_id}\" has no revision after {}.",
                    u32::MAX
                ),
            )
        })?;

    let head = value.len().min(CHUNK_BYTES);
    let mut chunk_count = 0;
    for part in value[head..].chunks(CHUNK_BYTES) {
        chunk_count += 1;
        txn.put(&layout::chunk(bundle, type_id, id, chunk_count), part)?;
    }
    let index_keys: Vec<Vec<u8>> = keys.iter().map(|key| key.key.clone()).collect();
    let old_keys = old
        .as_ref()
        .map_or(&[][..], |header| &header.index_keys[..]);
    if let Some(old) = &old {
        for n in chunk_count + 1..=old.chunk_count {
            txn.delete(&layout::chunk(bundle, type_id, id, n))?;
        }
    }
    for key in old_keys.iter().filter(|key| !index_keys.contains(key)) {
        txn.delete(&layout::prefixed(bundle, key))?;
    }
    for key in keys.iter().filter(|key| !old_keys.contains(&key.key)) {
        let entry: &[u8] = if key.unique { id.as_bytes() } else { b"" };
        txn.put(&layout::prefixed(bundle, &key.key), entry)?;
    }

    let header = DocumentHeader {
        revision,
        value_size: u32::try_from(value.len()).expect("a value holds at most 16 MiB"),
        chunk_count,
        chunk: value[..head].to_vec(),
        index_keys,
        updated_at: updated_at.to_owned(),
    };
    txn.put(&document, &prost::Message::encode_to_vec(&header))?;
    staged.put(document, Header::from(header));
    Ok(())
}

/// The stored declaration of `type_id`, read once per transaction into
/// `declarations`.
///
/// # Errors
///
/// `unknown_type` for a type with no stored declaration; the errors of
/// [`stored_declaration`].
fn declared(
    txn: &mut dyn ReadTxn,
    declarations: &mut BTreeMap<String, TypeDeclaration>,
    bundle: &str,
    type_id: &str,
) -> Result<TypeDeclaration, ContractError> {
    if let Some(declaration) = declarations.get(type_id) {
        return Ok(declaration.clone());
    }
    let declaration =
        stored_declaration(txn, bundle, type_id)?.ok_or_else(|| unknown_type(type_id))?;
    declarations.insert(type_id.to_owned(), declaration.clone());
    Ok(declaration)
}

/// The index keys of `put` under `declaration`: none for a type without
/// indexes, which is never decoded; otherwise its value decoded with the
/// declaration's schema, whose pool `pools` caches.
///
/// # Errors
///
/// `internal` for a stored schema that is missing or does not decode, or that
/// lacks the declaration's message; the errors of [`schema::json_form`],
/// [`schema::index_values`] and [`layout::index`].
fn index_keys(
    txn: &mut dyn ReadTxn,
    pools: &Pools,
    bundle: &str,
    declaration: &TypeDeclaration,
    (type_id, id, value): Put<'_>,
) -> Result<Vec<IndexKey>, ContractError> {
    if declaration.indexes.is_empty() {
        return Ok(Vec::new());
    }
    let hash = &declaration.schema;
    let pool = pools.get_or_build(hash, || {
        let (bytes, _) = txn
            .get(&layout::schema(bundle, hash))?
            .ok_or_else(|| internal(format!("The stored schema {hash} is missing.")))?;
        schema::pool(&bytes).map_err(|error| {
            internal(format!(
                "The stored schema {hash} does not decode: {}",
                error.message
            ))
        })
    })?;
    let message = pool
        .get_message_by_name(&declaration.message_type)
        .ok_or_else(|| {
            internal(format!(
                "The stored schema {hash} has no message {}.",
                declaration.message_type
            ))
        })?;
    let json = schema::json_form(&message, value)?;
    declaration
        .indexes
        .iter()
        .map(|index| {
            let values = schema::index_values(&json, &index.fields)?;
            let key = layout::index(type_id, &index.name, &values, (!index.unique).then_some(id))?;
            Ok(IndexKey {
                key,
                index: index.name.clone(),
                unique: index.unique,
            })
        })
        .collect()
}

/// An `internal` error with `message`.
pub(crate) fn internal(message: String) -> ContractError {
    ContractError::new("internal", message)
}

/// A [`ContractError`] of `code` with `message` and the details `fields`.
pub(crate) fn detailed<const N: usize>(
    code: &str,
    message: String,
    fields: [(&str, prost_types::Value); N],
) -> ContractError {
    ContractError {
        details: Some(prost_types::Struct {
            fields: fields
                .into_iter()
                .map(|(field, value)| (field.to_owned(), value))
                .collect(),
        }),
        ..ContractError::new(code, message)
    }
}
