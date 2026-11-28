//! S77a3b: `Query`'s tests and their shared support: in [`check`], the checks
//! before any I/O (Q1–Q4b); in [`page`] and [`paging`], a page read from a
//! store (Q5–Q17).

mod check;
mod page;
mod paging;

use std::ops::ControlFlow;

use base64::Engine as _;
use doric_sqlite::{KvEngine as _, SqliteEngine};
use prost_types::{ListValue, Struct, Value, value::Kind};

use super::*;
use crate::{
    commit::{self, Batch, Clock},
    keys::Element,
    schema::Pools,
    testing::{NOTE, detail_str, note},
    v2::{
        CommitRequest, DocumentKey, QueryPage, StorageQuery, StorageRange, StoredDocument,
        commit_request, query_response::Item,
    },
};

fn string(text: &str) -> Value {
    Value {
        kind: Some(Kind::StringValue(text.to_owned())),
    }
}

fn number(value: f64) -> Value {
    Value {
        kind: Some(Kind::NumberValue(value)),
    }
}

fn struct_value() -> Value {
    Value {
        kind: Some(Kind::StructValue(Struct::default())),
    }
}

fn list_value() -> Value {
    Value {
        kind: Some(Kind::ListValue(ListValue::default())),
    }
}

fn no_kind() -> Value {
    Value { kind: None }
}

fn element(text: &str) -> Element {
    Element::String(text.to_owned())
}

/// A query of `index` of `type_id` with a limit of 10 and nothing else.
fn query(type_id: &str, index: &str) -> StorageQuery {
    StorageQuery {
        r#type: type_id.to_owned(),
        index: index.to_owned(),
        limit: 10,
        ..StorageQuery::default()
    }
}

fn request(query: StorageQuery) -> QueryRequest {
    QueryRequest {
        storage_query: Some(query),
    }
}

/// The error `check` answers for `query` under the bundle `a`.
fn refused(query: StorageQuery) -> ContractError {
    check("a", &request(query)).expect_err("the query is refused")
}

fn code_and_message(error: &ContractError) -> (&str, &str) {
    (error.code.as_str(), error.message.as_str())
}

/// A plan of `index` of `type_id` with no values, ascending, `limit`, no
/// cursor.
fn plan(type_id: &str, index: &str, limit: usize) -> Plan {
    Plan {
        type_id: type_id.to_owned(),
        index: index.to_owned(),
        equals: Vec::new(),
        range: None,
        reverse: false,
        limit,
        cursor: None,
    }
}

/// Commits, in one batch for the bundle `a`, a put of each `(type, id,
/// value)` of `documents`.
async fn put_all(engine: &SqliteEngine, documents: &[(&str, &str, Vec<u8>)]) {
    let mut batch = Batch::new("a");
    for (type_id, id, value) in documents {
        let key = DocumentKey {
            r#type: (*type_id).to_owned(),
            id: (*id).to_owned(),
        };
        let mut items = vec![commit_request::Item::Put(key)];
        items.extend(
            value
                .chunks(commit::PART_BYTES)
                .map(|part| commit_request::Item::Chunk(part.to_vec())),
        );
        for item in items {
            batch
                .push(CommitRequest { item: Some(item) })
                .expect("a valid item");
        }
    }
    let items = batch.finish().expect("a valid batch");
    commit::apply(
        engine,
        &Clock::default(),
        &Pools::default(),
        &crate::cache::Headers::default(),
        &crate::watch::Watchers::default(),
        items,
    )
    .await
    .expect("the puts commit");
}

/// `count` notes `n<k>` with the title `t<k>` and the tag `x`.
fn titles(count: usize) -> Vec<(&'static str, String, Vec<u8>)> {
    (0..count)
        .map(|n| (NOTE, format!("n{n}"), note(&format!("t{n}"), "x")))
        .collect()
}

/// [`put_all`] of documents with owned ids.
async fn put_owned(engine: &SqliteEngine, documents: &[(&'static str, String, Vec<u8>)]) {
    let borrowed: Vec<_> = documents
        .iter()
        .map(|(type_id, id, value)| (*type_id, id.as_str(), value.clone()))
        .collect();
    put_all(engine, &borrowed).await;
}

/// The items `page` emits for `plan` under `a`, taking at most `take`.
async fn page_items(
    engine: &SqliteEngine,
    plan: Plan,
    take: usize,
) -> Result<Vec<Item>, ContractError> {
    engine
        .read(move |txn| {
            let mut items = Vec::new();
            page(txn, "a", &plan, &mut |response| {
                items.push(response.item.expect("an item"));
                if items.len() < take {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            })?;
            Ok(items)
        })
        .await
}

/// One page of `plan`: its `next_cursor` and the ids of its documents.
async fn ids_page(engine: &SqliteEngine, plan: Plan) -> (Option<String>, Vec<String>) {
    let items = page_items(engine, plan, usize::MAX)
        .await
        .expect("the page reads");
    let Some(Item::Page(QueryPage { next_cursor })) = items.first().cloned() else {
        panic!("the first item is the page: {items:?}");
    };
    let ids = items
        .iter()
        .filter_map(|item| match item {
            Item::Document(StoredDocument { id, .. }) => Some(id.clone()),
            _ => None,
        })
        .collect();
    (next_cursor, ids)
}

/// The decoded bytes of a `next_cursor`.
fn cursor_bytes(cursor: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .expect("a cursor is unpadded base64url")
}

/// Every page of `plan` from its first, following `next_cursor`: each page's
/// ids and whether it has a cursor.
async fn all_pages(engine: &SqliteEngine, mut plan: Plan) -> Vec<(Vec<String>, bool)> {
    let mut pages = Vec::new();
    loop {
        let (cursor, ids) = ids_page(engine, plan.clone()).await;
        pages.push((ids, cursor.is_some()));
        let Some(cursor) = cursor else {
            return pages;
        };
        assert!(pages.len() <= 100, "the pages end");
        plan.cursor = Some(cursor_bytes(&cursor));
    }
}
