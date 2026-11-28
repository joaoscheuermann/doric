//! `storage/v2.Query` (spec "The storage contract", "Get and Query", and Q-C):
//! one page of a declared index, its entries and the documents they name read
//! in one read transaction.

use std::ops::ControlFlow;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use doric_bundle::ContractError;
use doric_sqlite::{KeyRange, ReadTxn};
use prost_types::{Value, value::Kind};

use crate::{
    documents::{DocumentItems, emit_document, stored_header, unknown_type},
    keys::{self, Element, Range},
    layout,
    register::stored_declaration,
    schema,
    v2::{QueryPage, QueryRequest, QueryResponse, StoredDocument, query_response::Item},
};

/// The most documents a page holds; a query's `limit` is 1 to this.
pub const LIMIT: usize = 1_000;

/// A query [`check`] accepted, before any I/O: every value an element, every
/// limit, order and cursor of the right form. It names a type of the caller's
/// namespace; whether the type and its index exist is [`page`]'s to find.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The storage type, `StorageQuery.type`.
    pub type_id: String,
    /// The index's name, `StorageQuery.index`.
    pub index: String,
    /// The values the index's leading fields equal, in key order.
    pub equals: Vec<Element>,
    /// The range of the next field; `None` when the query gives no `range`,
    /// `Some` of an empty [`Range`] when it gives one with no bound (the
    /// arity rule of [`page`] tells the two apart, as
    /// `bundles/foundation/postgres/src/host/storage/query.ts:40-44` does).
    /// At most one of `gt`/`gte` and one of `lt`/`lte` is set.
    pub range: Option<Range>,
    /// Whether the page reads the index from its last key (`order: "desc"`).
    pub reverse: bool,
    /// The most documents the page holds, 1 to [`LIMIT`].
    pub limit: usize,
    /// The decoded `cursor`: the tuple bytes, after `("idx", type, name)`, of
    /// the last entry of the previous page; `None` for the first page.
    pub cursor: Option<Vec<u8>>,
}

/// Checks `request` for the bundle `bundle`, the caller's ([`crate::bundle`]),
/// before any I/O, and answers its [`Plan`]. The checks run in this order and
/// the first that fails answers: `storage_query` is present; the type's length,
/// then its namespace ([`crate::schema::owned`]); `limit` is 1 to [`LIMIT`];
/// `order` is absent, `"asc"` or `"desc"`; each value of `equals`, then each
/// bound of `range` (`gt`, `gte`, `lt`, `lte`), has a kind that is null, a
/// boolean, a finite number or a string; `range` sets at most one of
/// `gt`/`gte` and one of `lt`/`lte`; `cursor` is unpadded base64url
/// (RFC 4648, section 5, without `=`). The caller `doric` is refused before,
/// by [`crate::bundle`]. Neither the index nor the cursor's place in the
/// bounds is checked here.
///
/// # Errors
///
/// - `invalid_input`, message `A query request holds a storage_query.`, when
///   it is absent;
/// - the errors of [`crate::schema::owned`]: `invalid_input` (detail `type`)
///   for a type id of 0 or more than 128 bytes, then `not_owner` (detail
///   `type`) for a type of another namespace;
/// - `invalid_input`, message `A query's limit is 1 to 1000; <limit> is not.`;
/// - `invalid_input`, message `A query's order is "asc" or "desc"; "<order>"
///   is not.`;
/// - `invalid_input`, message `A query value has no kind.`, for a value of
///   `equals` or a bound with no kind set; `invalid_index_value`, message `A
///   query value is a string, a number, a boolean or null, not a struct.` (or
///   `not a list.`) for a struct or list value; `invalid_index_value`, message
///   `An indexed number must be finite, not <NaN|Infinity|-Infinity>.`
///   ([`crate::keys::encode`]'s), for a number that is not finite;
/// - `invalid_input`, the messages of [`crate::keys::bounds`] (`A range takes
///   either gt or gte, not both.`, then the `lt`/`lte` one), for both bounds of
///   a pair;
/// - `invalid_input`, message `A cursor is unpadded base64url.`, for a cursor
///   that does not decode, `=` padding included.
///
/// None of these errors has details unless named.
pub fn check(bundle: &str, request: &QueryRequest) -> Result<Plan, ContractError> {
    let Some(query) = &request.storage_query else {
        return Err(invalid("A query request holds a storage_query."));
    };
    schema::owned(&query.r#type, bundle)?;
    let limit = usize::try_from(query.limit)
        .ok()
        .filter(|limit| (1..=LIMIT).contains(limit))
        .ok_or_else(|| {
            invalid(format!(
                "A query's limit is 1 to {LIMIT}; {} is not.",
                query.limit
            ))
        })?;
    let reverse = match query.order.as_deref() {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(order) => {
            return Err(invalid(format!(
                "A query's order is \"asc\" or \"desc\"; \"{order}\" is not."
            )));
        }
    };
    let equals = query
        .equals
        .iter()
        .map(element)
        .collect::<Result<Vec<_>, _>>()?;
    let range = query
        .range
        .as_ref()
        .map(|range| -> Result<Range, ContractError> {
            let bound = |value: &Option<Value>| value.as_ref().map(element).transpose();
            Ok(Range {
                gt: bound(&range.gt)?,
                gte: bound(&range.gte)?,
                lt: bound(&range.lt)?,
                lte: bound(&range.lte)?,
            })
        })
        .transpose()?;
    keys::bounds(&equals, &range.clone().unwrap_or_default())?;
    let cursor = query
        .cursor
        .as_ref()
        .map(|cursor| {
            base64::Engine::decode(&URL_SAFE_NO_PAD, cursor)
                .map_err(|_| invalid("A cursor is unpadded base64url."))
        })
        .transpose()?;
    Ok(Plan {
        type_id: query.r#type.clone(),
        index: query.index.clone(),
        equals,
        range,
        reverse,
        limit,
        cursor,
    })
}

/// `invalid_input`, with no details, with `message`.
fn invalid(message: impl Into<String>) -> ContractError {
    ContractError::new("invalid_input", message)
}

/// The element of a query value, as [`crate::schema::index_values`] gives a
/// document's.
fn element(value: &Value) -> Result<Element, ContractError> {
    let not = |kind: &str| {
        ContractError::new(
            "invalid_index_value",
            format!("A query value is a string, a number, a boolean or null, not a {kind}."),
        )
    };
    match &value.kind {
        None => Err(invalid("A query value has no kind.")),
        Some(Kind::NullValue(_)) => Ok(Element::Null),
        Some(Kind::BoolValue(value)) => Ok(Element::Bool(*value)),
        Some(Kind::NumberValue(number)) => {
            let element = Element::Number(*number);
            keys::encode(std::slice::from_ref(&element))?;
            Ok(element)
        }
        Some(Kind::StringValue(text)) => Ok(Element::String(text.clone())),
        Some(Kind::StructValue(_)) => Err(not("struct")),
        Some(Kind::ListValue(_)) => Err(not("list")),
    }
}

/// Reads one page of `plan` under `bundle`'s prefix in `txn`, a single read
/// transaction, so the page is one snapshot, and passes its items to `emit`,
/// in order: one `page` item first, then per document its `document` item
/// (type, id, revision) and its value's `chunk` items, as
/// [`crate::documents::get`] emits them. `plan` is one [`check`] accepted.
///
/// In the transaction, in order: the type has a stored declaration; it
/// declares the index `plan.index`; `plan.equals` is no longer than the
/// index's fields and, with a range, shorter
/// (`bundles/foundation/postgres/src/host/storage/query.ts:40-49`); the cursor
/// lies in [`crate::keys::bounds`]`(equals, range)`, `lower <= cursor <
/// upper`. Then it reads the entries of `("idx", type, index)` whose tuple
/// bytes after that prefix lie in the bounds, in key order (from the last
/// with `plan.reverse`), strictly after the cursor in that order, and at
/// most `limit + 1` of them. A unique index's entry names its document by
/// its value (the id's UTF-8) and its key has no id; a non-unique index's
/// entry names it by its key's last element, so equal values sort by id
/// bytewise. The cursor of an entry is its tuple bytes after the prefix
/// (values only for a unique index, values then id otherwise).
///
/// The `page` item's `next_cursor` is the unpadded base64url of the cursor of
/// the last document's entry when a `(limit + 1)`th entry exists, and absent
/// otherwise, so a page holds `limit` documents unless the list ends, and a
/// page with no document still has its `page` item. It stops with `Ok` as soon
/// as `emit` answers [`ControlFlow::Break`], with no read after it.
///
/// # Errors
///
/// Before any item: `unknown_type` (details `{type}`, message `Storage type
/// <type> is not defined.`) for a type with no stored declaration;
/// `invalid_input`, message `Type <type> has no declared index "<index>".`;
/// `invalid_input`, message `The index "<index>" of <type> has <n> fields:
/// equality takes the leading ones and a range the next one.`;
/// `invalid_input`, message `The cursor is outside the query's bounds.`. Then
/// `internal` for an index entry that does not decode, names no stored
/// document, or whose header or chunks are missing or undecodable; the errors
/// of [`ReadTxn::get`] and [`ReadTxn::range`]. Items already emitted stand.
pub fn page(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    plan: &Plan,
    emit: &mut dyn FnMut(QueryResponse) -> ControlFlow<()>,
) -> Result<(), ContractError> {
    let type_id = plan.type_id.as_str();
    let Some(declaration) = stored_declaration(txn, bundle, type_id)? else {
        return Err(unknown_type(type_id));
    };
    let Some(index) = declaration
        .indexes
        .iter()
        .find(|index| index.name == plan.index)
    else {
        return Err(invalid(format!(
            "Type {type_id} has no declared index \"{}\".",
            plan.index
        )));
    };
    let fields = index.fields.len();
    if plan.equals.len() > fields || (plan.range.is_some() && plan.equals.len() >= fields) {
        return Err(invalid(format!(
            "The index \"{}\" of {type_id} has {fields} fields: equality takes the leading ones and a range the next one.",
            plan.index
        )));
    }
    let (lower, upper) = keys::bounds(&plan.equals, &plan.range.clone().unwrap_or_default())?;
    if let Some(cursor) = &plan.cursor
        && !(lower <= *cursor && *cursor < upper)
    {
        return Err(invalid("The cursor is outside the query's bounds."));
    }

    let prefix = layout::under(bundle, &["idx", type_id, &plan.index]).start;
    let (start, end) = match (&plan.cursor, plan.reverse) {
        (None, _) => (lower, upper),
        // The first key after the cursor's is the cursor's followed by 0x00.
        (Some(cursor), false) => ([cursor.as_slice(), &[0x00]].concat(), upper),
        (Some(cursor), true) => (lower, cursor.clone()),
    };
    let range = KeyRange {
        start: [prefix.as_slice(), &start].concat(),
        end: [prefix.as_slice(), &end].concat(),
        reverse: plan.reverse,
        keys_only: false,
    };
    let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    txn.range(&range, &mut |entry| {
        entries.push((entry.key[prefix.len()..].to_vec(), entry.value.to_vec()));
        if entries.len() > plan.limit {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;

    let next_cursor = (entries.len() > plan.limit)
        .then(|| base64::Engine::encode(&URL_SAFE_NO_PAD, &entries[plan.limit - 1].0));
    entries.truncate(plan.limit);
    if emit(QueryResponse {
        item: Some(Item::Page(QueryPage { next_cursor })),
    })
    .is_break()
    {
        return Ok(());
    }
    for (tuple, value) in entries {
        let id = entry_id(index.unique, &tuple, value)?;
        let Some(header) = stored_header(txn, bundle, type_id, &id)? else {
            return Err(ContractError::new(
                "internal",
                format!(
                    "The index entry of \"{}\" of \"{type_id}\" names no stored document \"{id}\".",
                    plan.index
                ),
            ));
        };
        if emit_document(txn, bundle, type_id, &id, header, emit)?.is_break() {
            return Ok(());
        }
    }
    Ok(())
}

/// The id an index entry names: a unique entry's value, the UTF-8 of the id,
/// or a non-unique entry's last element, from `tuple`, its key after the
/// `("idx", type, name)` prefix.
///
/// # Errors
///
/// `internal` for an entry that does not decode.
fn entry_id(unique: bool, tuple: &[u8], value: Vec<u8>) -> Result<String, ContractError> {
    let undecodable = || ContractError::new("internal", "An index entry does not decode.");
    if unique {
        return String::from_utf8(value).map_err(|_| undecodable());
    }
    match keys::decode(tuple).map_err(|_| undecodable())?.pop() {
        Some(Element::String(id)) => Ok(id),
        _ => Err(undecodable()),
    }
}

impl DocumentItems for QueryResponse {
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

#[cfg(test)]
mod tests;
