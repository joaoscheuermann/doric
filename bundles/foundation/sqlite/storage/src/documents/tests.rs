//! S77a3a: `Get`'s checks and its items (G1–G6).

use doric_sqlite::{KvEngine as _, SqliteEngine};

use super::*;
use crate::{
    commit::{self, Batch, Clock},
    layout::{CHUNK_BYTES, ID_BYTES},
    schema::Pools,
    testing::{NOTE, PLAIN, detail_str, documents_store},
    v2::{CommitRequest, DocumentKey, StoredDocument, commit_request, get_response::Item},
};

fn request(type_id: &str, id: &str) -> GetRequest {
    GetRequest {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
    }
}

/// Commits a put of `value` as `(type_id, id)` for the bundle `a`.
async fn put(engine: &SqliteEngine, type_id: &str, id: &str, value: &[u8]) {
    let mut batch = Batch::new("a");
    let key = DocumentKey {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
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
    let items = batch.finish().expect("a valid batch");
    commit::apply(
        engine,
        &Clock::default(),
        &Pools::default(),
        &crate::watch::Watchers::default(),
        items,
    )
    .await
    .expect("the put commits");
}

/// The items `get` emits for `(type_id, id)` under `a`, taking at most
/// `take` of them.
async fn get_items(
    engine: &SqliteEngine,
    type_id: &str,
    id: &str,
    take: usize,
) -> Result<Vec<Item>, ContractError> {
    let request = request(type_id, id);
    engine
        .read(move |txn| {
            let mut items = Vec::new();
            get(txn, "a", &request, &mut |response| {
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

async fn all_items(engine: &SqliteEngine, type_id: &str, id: &str) -> Vec<Item> {
    get_items(engine, type_id, id, usize::MAX)
        .await
        .expect("the get succeeds")
}

fn document(type_id: &str, id: &str, revision: f64) -> Item {
    Item::Document(StoredDocument {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
        revision,
    })
}

/// The bytes of the `chunk` items of `items`, each at most `CHUNK_BYTES`.
fn chunks(items: &[Item]) -> Vec<Vec<u8>> {
    items
        .iter()
        .map(|item| match item {
            Item::Chunk(bytes) => bytes.clone(),
            Item::Document(_) => panic!("a document after the first item"),
        })
        .collect()
}

#[test]
fn check_refuses_another_namespace_and_a_long_type_or_id() {
    let error = check("a", &request("b.x/v1", "1")).expect_err("not a's");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "type").as_deref(), Some("b.x/v1"));

    let long_type = format!("a.{}", "x".repeat(127));
    assert_eq!(
        check("a", &request(&long_type, "1"))
            .expect_err("too long")
            .code,
        "invalid_input"
    );
    let long_id = "i".repeat(ID_BYTES + 1);
    assert_eq!(
        check("a", &request(NOTE, &long_id))
            .expect_err("too long")
            .code,
        "invalid_input"
    );
    check("a", &request(NOTE, "n1")).expect("a's type and a short id pass");
}

#[tokio::test]
async fn an_undeclared_type_is_unknown_type() {
    let (_dir, engine) = documents_store().await;

    let error = get_items(&engine, "a.other/v1", "1", usize::MAX)
        .await
        .expect_err("a.other/v1 is not declared");

    assert_eq!(error.code, "unknown_type");
    assert_eq!(detail_str(&error, "type").as_deref(), Some("a.other/v1"));
}

#[tokio::test]
async fn an_absent_document_emits_nothing() {
    let (_dir, engine) = documents_store().await;

    assert_eq!(all_items(&engine, PLAIN, "absent").await, Vec::new());
}

#[tokio::test]
async fn a_present_document_emits_its_document_then_its_value_in_chunks() {
    let (_dir, engine) = documents_store().await;
    put(&engine, PLAIN, "p1", b"value").await;

    let items = all_items(&engine, PLAIN, "p1").await;

    assert_eq!(items[0], document(PLAIN, "p1", 1.0));
    assert_eq!(chunks(&items[1..]).concat(), b"value");
}

#[tokio::test]
async fn an_empty_value_emits_only_its_document() {
    let (_dir, engine) = documents_store().await;
    put(&engine, PLAIN, "p1", b"").await;

    assert_eq!(
        all_items(&engine, PLAIN, "p1").await,
        vec![document(PLAIN, "p1", 1.0)]
    );
}

#[tokio::test]
async fn a_large_value_comes_in_chunks_of_1_to_chunk_bytes() {
    let (_dir, engine) = documents_store().await;
    let value: Vec<u8> = (0..2 * CHUNK_BYTES + 5)
        .map(|n| u8::try_from(n % 251).expect("below 251"))
        .collect();
    put(&engine, PLAIN, "p1", &value).await;

    let items = all_items(&engine, PLAIN, "p1").await;

    assert_eq!(items[0], document(PLAIN, "p1", 1.0));
    let parts = chunks(&items[1..]);
    for part in &parts {
        assert!(
            (1..=CHUNK_BYTES).contains(&part.len()),
            "{} bytes",
            part.len()
        );
    }
    assert_eq!(parts.concat(), value);
}

#[tokio::test]
async fn an_emit_that_breaks_stops_the_read_with_ok() {
    let (_dir, engine) = documents_store().await;
    put(&engine, PLAIN, "p1", &vec![7; 2 * CHUNK_BYTES + 5]).await;

    let items = get_items(&engine, PLAIN, "p1", 1)
        .await
        .expect("a break is Ok");

    assert_eq!(items, vec![document(PLAIN, "p1", 1.0)]);
}
