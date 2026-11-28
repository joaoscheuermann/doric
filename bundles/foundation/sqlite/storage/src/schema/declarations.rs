//! The pool of a descriptor set and the storage types it declares (A81).

use std::collections::BTreeMap;

use doric_bundle::ContractError;
use doric_sqlite::refusal;
use prost_reflect::{DescriptorPool, MessageDescriptor, Value};

use super::{DESCRIPTOR_SET_BYTES, MAX_INDEX_FIELDS, MAX_INDEXES, TYPE_ID_BYTES};
use crate::layout::{IndexDeclaration, TypeDeclaration};

/// The descriptor pool of `descriptor_set`, a binary
/// `google.protobuf.FileDescriptorSet`: every message of its files, resolved
/// against the set's own files only.
///
/// # Errors
///
/// `limit_exceeded` (`details.limit` `"descriptorSet"`) for more than
/// [`DESCRIPTOR_SET_BYTES`] bytes, checked before any decoding;
/// `invalid_input` when the bytes do not decode as a `FileDescriptorSet` or a
/// file does not resolve (an import or a type missing from the set).
pub fn pool(descriptor_set: &[u8]) -> Result<DescriptorPool, ContractError> {
    if descriptor_set.len() > DESCRIPTOR_SET_BYTES {
        return Err(refusal(
            "limit_exceeded",
            format!(
                "The descriptor set holds {} bytes; the limit is {DESCRIPTOR_SET_BYTES}.",
                descriptor_set.len()
            ),
            "limit",
            "descriptorSet".into(),
        ));
    }
    DescriptorPool::decode(descriptor_set).map_err(|error| {
        ContractError::new(
            "invalid_input",
            format!("The descriptor set does not decode: {error}."),
        )
    })
}

/// The storage types `pool` declares, keyed by type id: one
/// [`TypeDeclaration`] per message with the option
/// `(doric.platform.v1.storage_type)`, holding the message's full name and the
/// option's indexes in declaration order (an absent `unique` is `false`), with
/// `schema` left empty for the caller to fill.
///
/// Every message with `storage_type` or `stream_entry` is checked, in pool
/// order; a stream entry declares no type. A pool without
/// `doric/platform/v1/options.proto` declares nothing and is `Ok` and empty.
///
/// # Errors
///
/// The first refusal, in pool order:
///
/// - `not_owner` (detail `type`) when a type's namespace, the part of its id
///   before its first `.` or `/`, is not `owner`; `not_owner` (detail
///   `prefix`) when a stream prefix's owner, the part before its first `.`, is
///   not `owner`;
/// - `invalid_input` (detail `type`) for an empty type id or one over
///   [`TYPE_ID_BYTES`] bytes; a type declared by two messages; more than
///   [`MAX_INDEXES`] indexes, or an index of more than [`MAX_INDEX_FIELDS`]
///   fields; two indexes of one name; an index field whose JSON-name path does
///   not pass through singular message fields to a singular scalar, enum,
///   string, bool or bytes field, or a `Timestamp`, `Duration` or wrapper.
pub fn declarations(
    pool: &DescriptorPool,
    owner: &str,
) -> Result<BTreeMap<String, TypeDeclaration>, ContractError> {
    let storage_type = pool.get_extension_by_name("doric.platform.v1.storage_type");
    let stream_entry = pool.get_extension_by_name("doric.platform.v1.stream_entry");
    let mut declared = BTreeMap::new();
    for message in pool.all_messages() {
        let options = message.options();
        if let Some(extension) = &stream_entry
            && options.has_extension(extension)
        {
            let entry = options.get_extension(extension);
            let prefix = text(&entry, "prefix");
            if prefix.split('.').next() != Some(owner) {
                return Err(refusal(
                    "not_owner",
                    format!("The stream prefix \"{prefix}\" is not of the bundle {owner}."),
                    "prefix",
                    prefix.into(),
                ));
            }
        }
        if let Some(extension) = &storage_type
            && options.has_extension(extension)
        {
            let option = options.get_extension(extension);
            let (type_id, declaration) = declare(&message, &option, owner)?;
            if declared.contains_key(&type_id) {
                return Err(invalid_type(
                    &type_id,
                    format!("The type \"{type_id}\" is declared by two messages."),
                ));
            }
            declared.insert(type_id, declaration);
        }
    }
    Ok(declared)
}

/// Checks that the bundle `owner` owns the type `type_id`, before any I/O, in
/// this order: the id's length, then its namespace, the part before its first
/// `.` or `/`. [`declarations`] checks each declared type with it, and
/// `storage/v2`'s `Commit`, `Get` and `Query` each type they name.
///
/// # Errors
///
/// - `invalid_input` (detail `type`, the id), message `A type id holds 1 to
///   128 bytes; "<type>" holds <n>.`, for an empty id or one over
///   [`TYPE_ID_BYTES`] bytes;
/// - `not_owner` (detail `type`, the id), message `The type "<type>" is not
///   of the bundle <owner>.`, when the namespace is not `owner`.
pub fn owned(type_id: &str, owner: &str) -> Result<(), ContractError> {
    if type_id.is_empty() || type_id.len() > TYPE_ID_BYTES {
        return Err(invalid_type(
            type_id,
            format!(
                "A type id holds 1 to {TYPE_ID_BYTES} bytes; \"{type_id}\" holds {}.",
                type_id.len()
            ),
        ));
    }
    let namespace = type_id.split(['.', '/']).next().unwrap_or_default();
    if namespace != owner {
        return Err(refusal(
            "not_owner",
            format!("The type \"{type_id}\" is not of the bundle {owner}."),
            "type",
            type_id.into(),
        ));
    }
    Ok(())
}

/// The type id and the declaration of `message`, whose option
/// `storage_type` is `option`, checked as [`declarations`] checks them.
fn declare(
    message: &MessageDescriptor,
    option: &Value,
    owner: &str,
) -> Result<(String, TypeDeclaration), ContractError> {
    let type_id = text(option, "type");
    owned(&type_id, owner)?;
    let indexes = list(option, "indexes");
    if indexes.len() > MAX_INDEXES {
        return Err(invalid_type(
            &type_id,
            format!("The type \"{type_id}\" holds more than {MAX_INDEXES} indexes."),
        ));
    }
    let mut declared: Vec<IndexDeclaration> = Vec::with_capacity(indexes.len());
    for index in &indexes {
        let name = text(index, "name");
        let fields: Vec<String> = list(index, "fields")
            .iter()
            .map(|field| field.as_str().unwrap_or_default().to_owned())
            .collect();
        if fields.len() > MAX_INDEX_FIELDS {
            return Err(invalid_type(
                &type_id,
                format!(
                    "The index \"{name}\" of \"{type_id}\" holds more than {MAX_INDEX_FIELDS} fields."
                ),
            ));
        }
        if declared.iter().any(|other| other.name == name) {
            return Err(invalid_type(
                &type_id,
                format!("The type \"{type_id}\" holds two indexes named \"{name}\"."),
            ));
        }
        if let Some(field) = fields.iter().find(|field| !indexable(message, field)) {
            return Err(invalid_type(
                &type_id,
                format!(
                    "The field \"{field}\" of the index \"{name}\" of \"{type_id}\" is not a singular scalar, enum, Timestamp, Duration or wrapper reached through singular messages, by JSON names."
                ),
            ));
        }
        let unique = index
            .as_message()
            .and_then(|index| index.get_field_by_name("unique"))
            .and_then(|unique| unique.as_bool())
            .unwrap_or(false);
        declared.push(IndexDeclaration {
            name,
            fields,
            unique,
        });
    }
    let declaration = TypeDeclaration {
        message_type: message.full_name().to_owned(),
        indexes: declared,
        schema: String::new(),
    };
    Ok((type_id, declaration))
}

/// The well-known messages an index field may end at: their JSON form is a
/// string, a number or a boolean.
const INDEXABLE_MESSAGES: [&str; 11] = [
    "google.protobuf.Timestamp",
    "google.protobuf.Duration",
    "google.protobuf.DoubleValue",
    "google.protobuf.FloatValue",
    "google.protobuf.Int64Value",
    "google.protobuf.UInt64Value",
    "google.protobuf.Int32Value",
    "google.protobuf.UInt32Value",
    "google.protobuf.BoolValue",
    "google.protobuf.StringValue",
    "google.protobuf.BytesValue",
];

/// Whether `path`, JSON names separated by `.`, passes from `message` through
/// singular message fields, none of them well-known, to a singular scalar,
/// enum, string, bool or bytes field, or to a Timestamp, Duration or wrapper.
fn indexable(message: &MessageDescriptor, path: &str) -> bool {
    let mut current = message.clone();
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        let Some(field) = current.get_field_by_json_name(segment) else {
            return false;
        };
        if field.is_list() || field.is_map() {
            return false;
        }
        let kind = field.kind();
        let last = segments.peek().is_none();
        match kind.as_message() {
            None => return last,
            Some(inner) if last => return INDEXABLE_MESSAGES.contains(&inner.full_name()),
            Some(inner) if inner.full_name().starts_with("google.protobuf.") => return false,
            Some(inner) => current = inner.clone(),
        }
    }
    false
}

/// The string field `name` of the option message `option`, empty when absent.
fn text(option: &Value, name: &str) -> String {
    option
        .as_message()
        .and_then(|message| message.get_field_by_name(name))
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The repeated field `name` of the option message `option`.
fn list(option: &Value, name: &str) -> Vec<Value> {
    option
        .as_message()
        .and_then(|message| message.get_field_by_name(name))
        .and_then(|value| value.as_list().map(<[Value]>::to_vec))
        .unwrap_or_default()
}

/// An `invalid_input` refusal of the type `type_id`.
fn invalid_type(type_id: &str, message: String) -> ContractError {
    refusal("invalid_input", message, "type", type_id.into())
}

#[cfg(test)]
mod tests;
