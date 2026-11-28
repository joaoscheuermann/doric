//! `storage/v2.Get` (spec "The storage contract", "Get and Query"): one
//! document, its header and its chunks read in one read transaction.

use std::ops::ControlFlow;

use doric_bundle::ContractError;
use doric_sqlite::{ReadTxn, refusal};

use crate::{
    layout::{self, DocumentHeader},
    register::stored_declaration,
    v2::{GetRequest, GetResponse, StoredDocument, get_response::Item},
};

/// Checks `request` for the bundle `bundle`, the caller's ([`crate::bundle`]),
/// before any I/O: [`crate::layout::checked`]`(bundle, type, id)`.
///
/// # Errors
///
/// The errors of `checked`: the type's length (`invalid_input`), then its
/// namespace (`not_owner`), then the id's length (`invalid_input`).
pub fn check(bundle: &str, request: &GetRequest) -> Result<(), ContractError> {
    layout::checked(bundle, &request.r#type, &request.id)
}

/// Reads the document `request` names under `bundle`'s prefix in `txn` and
/// passes its items to `emit`, in order: one `document` item (type, id and
/// revision), then the value's bytes as `chunk` items of 1 to
/// [`crate::layout::CHUNK_BYTES`] bytes whose concatenation is the value. An
/// empty value has no chunk; an absent document emits nothing. `request` is
/// one [`check`] accepted.
///
/// It stops with `Ok` as soon as `emit` answers [`ControlFlow::Break`], with
/// no read after it.
///
/// # Errors
///
/// `unknown_type` (details `{type}`, message `Storage type <type> is not
/// defined.`) when the type has no stored declaration, before any item;
/// `internal` for a header that does not decode or a chunk it counts that is
/// missing; the errors of [`ReadTxn::get`] and [`ReadTxn::range`]. Items
/// already emitted stand.
pub fn get(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    request: &GetRequest,
    emit: &mut dyn FnMut(GetResponse) -> ControlFlow<()>,
) -> Result<(), ContractError> {
    let (type_id, id) = (request.r#type.as_str(), request.id.as_str());
    if stored_declaration(txn, bundle, type_id)?.is_none() {
        return Err(unknown_type(type_id));
    }
    let Some(header) = stored_header(txn, bundle, type_id, id)? else {
        return Ok(());
    };
    emit_document(txn, bundle, type_id, id, header, emit).map(|_| ())
}

/// A response that carries a document's items: Get's and Query's.
pub(crate) trait DocumentItems {
    /// The response of a `document` item.
    fn document(document: StoredDocument) -> Self;
    /// The response of a `chunk` item.
    fn chunk(bytes: Vec<u8>) -> Self;
}

impl DocumentItems for GetResponse {
    fn document(document: StoredDocument) -> Self {
        Self {
            item: Some(Item::Document(document)),
        }
    }

    fn chunk(bytes: Vec<u8>) -> Self {
        Self {
            item: Some(Item::Chunk(bytes)),
        }
    }
}

/// Passes to `emit` the document `(type_id, id)` whose stored header is
/// `header`: its `document` item (type, id and revision), then its value's
/// bytes as `chunk` items, the header's bytes first then each stored chunk's. An empty value has no chunk. It
/// answers [`ControlFlow::Break`] as soon as `emit` does, with no read after.
///
/// # Errors
///
/// `internal` for a chunk the header counts that is missing; the errors of
/// [`ReadTxn::get`].
pub(crate) fn emit_document<R: DocumentItems>(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    type_id: &str,
    id: &str,
    header: DocumentHeader,
    emit: &mut dyn FnMut(R) -> ControlFlow<()>,
) -> Result<ControlFlow<()>, ContractError> {
    let stored = StoredDocument {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
        revision: f64::from(header.revision),
    };
    if emit(R::document(stored)).is_break() {
        return Ok(ControlFlow::Break(()));
    }
    if !header.chunk.is_empty() && emit(R::chunk(header.chunk)).is_break() {
        return Ok(ControlFlow::Break(()));
    }
    for n in 1..=header.chunk_count {
        let Some((bytes, _)) = txn.get(&layout::chunk(bundle, type_id, id, n))? else {
            return Err(ContractError::new(
                "internal",
                format!("The chunk {n} of the document \"{id}\" of \"{type_id}\" is missing."),
            ));
        };
        if emit(R::chunk(bytes)).is_break() {
            return Ok(ControlFlow::Break(()));
        }
    }
    Ok(ControlFlow::Continue(()))
}

/// The stored header of `(type_id, id)` under `bundle`, if any.
///
/// # Errors
///
/// `internal` for a header that does not decode; the errors of
/// [`ReadTxn::get`].
pub(crate) fn stored_header(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    type_id: &str,
    id: &str,
) -> Result<Option<DocumentHeader>, ContractError> {
    txn.get(&layout::document(bundle, type_id, id))?
        .map(|(value, _)| decode_header(&value))
        .transpose()
}

/// Decodes the stored document header `value`; `internal`, the message `A
/// stored document header does not decode: <error>.`, when it does not.
pub(crate) fn decode_header(value: &[u8]) -> Result<DocumentHeader, ContractError> {
    <DocumentHeader as prost::Message>::decode(value).map_err(|error| {
        ContractError::new(
            "internal",
            format!("A stored document header does not decode: {error}."),
        )
    })
}

/// `unknown_type` (details `{type}`) for a type with no stored declaration.
pub(crate) fn unknown_type(type_id: &str) -> ContractError {
    refusal(
        "unknown_type",
        format!("Storage type {type_id} is not defined."),
        "type",
        type_id.into(),
    )
}

#[cfg(test)]
mod tests;
