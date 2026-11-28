//! A bundle's registered descriptors (A81): the pool of a descriptor set and
//! the storage types it declares ([`pool`], [`declarations`]), and the index
//! values of a stored value, decoded with them, in protobuf's JSON form, read
//! as `indexValues` reads them (`packages/storage/src/keys.ts:246`).

mod declarations;

use std::sync::{Arc, Mutex, PoisonError};

pub use declarations::{declarations, owned, pool};
use doric_bundle::ContractError;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, SerializeOptions};
use serde_json::Value as Json;

use crate::keys::Element;

/// The most bytes of a `RegisterRequest`'s or an `ImportStart`'s `descriptor_set`.
pub const DESCRIPTOR_SET_BYTES: usize = 2_097_152;
/// The most indexes of one type.
pub const MAX_INDEXES: usize = 16;
/// The most fields of one index.
pub const MAX_INDEX_FIELDS: usize = 8;
/// The most UTF-8 bytes of a type id.
pub const TYPE_ID_BYTES: usize = 128;

/// The most descriptor pools a [`Pools`] holds.
pub const POOLS: usize = 32;

/// The decoded descriptor pools of stored schemas, keyed by schema hash (the
/// lowercase SHA-256 hex a [`crate::layout::TypeDeclaration`]'s `schema`
/// names), so a commit decodes a schema's bytes with [`pool`] once, not once
/// per put. It is memory only, starts empty with each process, and clones
/// share one cache.
///
/// It holds at most [`POOLS`] pools. Each [`Pools::get_or_build`] that finds
/// or inserts a hash makes it the most recently used; inserting into a full
/// cache first evicts the least recently used pool. A hash's bytes never
/// change (the hash names them), so a cached pool is never stale; an evicted
/// one is only built again.
#[derive(Debug, Default, Clone)]
pub struct Pools {
    /// The cached pools, the least recently used first.
    entries: Arc<Mutex<Vec<Cached>>>,
}

/// A schema hash and its pool.
type Cached = (String, Arc<DescriptorPool>);

impl Pools {
    /// The pool of the schema `hash`: the cached one, or else the pool `build`
    /// answers, which is then cached under `hash`. `build` runs only on a miss,
    /// and not under the cache's lock, so two callers that miss one hash at
    /// once may both build; either pool is kept, and both describe the same
    /// bytes.
    ///
    /// # Errors
    ///
    /// The error of `build`, as is; nothing is cached, so the next call for
    /// `hash` builds again.
    pub fn get_or_build(
        &self,
        hash: &str,
        build: impl FnOnce() -> Result<DescriptorPool, ContractError>,
    ) -> Result<Arc<DescriptorPool>, ContractError> {
        if let Some(pool) = self.touch(hash, None) {
            return Ok(pool);
        }
        let pool = Arc::new(build()?);
        Ok(self
            .touch(hash, Some(pool))
            .expect("an inserted pool is found"))
    }

    /// The cached pool of `hash`, made the most recently used; when absent and
    /// `insert` is `Some`, that pool, cached as the most recently used after
    /// evicting the least recently used of a full cache.
    fn touch(
        &self,
        hash: &str,
        insert: Option<Arc<DescriptorPool>>,
    ) -> Option<Arc<DescriptorPool>> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = match entries.iter().position(|(cached, _)| cached == hash) {
            Some(found) => entries.remove(found),
            None => {
                let pool = insert?;
                if entries.len() >= POOLS {
                    entries.remove(0);
                }
                (hash.to_owned(), pool)
            }
        };
        let pool = Arc::clone(&entry.1);
        entries.push(entry);
        Some(pool)
    }
}

/// `value`, decoded as `message`, in protobuf's JSON form with every field that has
/// no presence written at its default (`toJson(…, { alwaysEmitImplicit: true })`):
/// JSON names, 64-bit integers as strings, enums by name, bytes in padded standard
/// base64, a repeated field as `[]` when empty, and an unset `optional` or message
/// field left out. Well-known types take protobuf-es's JSON form: a wrapper is its
/// value, and a Timestamp (`…:01.500Z`) or Duration (`1.500s`) has 0, 3, 6 or 9
/// fraction digits, the fewest that hold its nanos. Unknown fields are left out.
///
/// # Errors
///
/// `invalid_input` when `value` does not decode as `message` or has no JSON form.
pub fn json_form(
    message: &MessageDescriptor,
    value: &[u8],
) -> Result<serde_json::Value, ContractError> {
    let decoded = DynamicMessage::decode(message.clone(), value).map_err(|error| {
        ContractError::new(
            "invalid_input",
            format!(
                "The value does not decode as {}: {error}.",
                message.full_name()
            ),
        )
    })?;
    let options = SerializeOptions::new().skip_default_fields(false);
    decoded
        .serialize_with_options(serde_json::value::Serializer, &options)
        .map_err(|error| {
            ContractError::new(
                "invalid_input",
                format!("The value has no JSON form: {error}."),
            )
        })
}

/// One element per field of `fields` (dotted JSON names), as `indexValues` takes them
/// (`keys.ts:246`): each `.`-separated segment steps into an object's own key or,
/// when it is `0` or a decimal without a leading zero, into an array's element; a
/// missing path or `null` is `Null`; a string, number or boolean is itself.
///
/// # Errors
///
/// `invalid_index_value` when a path ends at an object or an array.
pub fn index_values(
    json: &serde_json::Value,
    fields: &[String],
) -> Result<Vec<Element>, ContractError> {
    fields
        .iter()
        .map(|field| match resolve(json, field) {
            None | Some(Json::Null) => Ok(Element::Null),
            Some(Json::Bool(value)) => Ok(Element::Bool(*value)),
            Some(Json::Number(number)) => Ok(Element::Number(
                number.as_f64().unwrap_or(f64::NAN),
            )),
            Some(Json::String(text)) => Ok(Element::String(text.clone())),
            Some(found) => {
                let holds = if found.is_array() { "an array" } else { "a object" };
                Err(ContractError::new(
                    "invalid_index_value",
                    format!(
                        "The index field \"{field}\" holds {holds}; only strings, numbers, booleans and null can be indexed."
                    ),
                ))
            }
        })
        .collect()
}

/// The value at `field`'s path, as `resolvePointer` finds it (`keys.ts:218`).
fn resolve<'a>(json: &'a Json, field: &str) -> Option<&'a Json> {
    field
        .split('.')
        .try_fold(json, |current, segment| match current {
            Json::Array(elements) => {
                let canonical = segment == "0"
                    || (!segment.starts_with('0')
                        && !segment.is_empty()
                        && segment.bytes().all(|byte| byte.is_ascii_digit()));
                if !canonical {
                    return None;
                }
                elements.get(segment.parse::<usize>().ok()?)
            }
            Json::Object(entries) => entries.get(segment),
            _ => None,
        })
}

#[cfg(test)]
mod tests;
