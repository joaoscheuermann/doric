//! S77a3a: `Commit`'s checks as the items arrive (C1–C11), the clock (C24),
//! and, in [`apply`] and [`conflicts`], the batch applied to a store.

mod apply;
mod conflicts;

use std::ops::ControlFlow;

use doric_sqlite::{KeyRange, SqliteEngine};
use prost::Message as _;

use super::*;
use crate::{
    documents,
    layout::{self, DocumentHeader},
    testing::{NOTE, detail_str},
    v2::{
        DocumentKey, ExpectedRevision, GetRequest, StreamAppend, StreamTruncate,
        commit_request::Item, get_response,
    },
};

fn request(item: Item) -> CommitRequest {
    CommitRequest { item: Some(item) }
}

fn key(type_id: &str, id: &str) -> DocumentKey {
    DocumentKey {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
    }
}

fn put(type_id: &str, id: &str) -> CommitRequest {
    request(Item::Put(key(type_id, id)))
}

fn delete(type_id: &str, id: &str) -> CommitRequest {
    request(Item::Delete(key(type_id, id)))
}

fn expect(type_id: &str, id: &str, revision: f64) -> CommitRequest {
    request(Item::Expect(ExpectedRevision {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
        revision,
    }))
}

fn chunk(bytes: &[u8]) -> CommitRequest {
    request(Item::Chunk(bytes.to_vec()))
}

/// A put of `value`, in chunks of at most [`PART_BYTES`].
fn put_value(type_id: &str, id: &str, value: &[u8]) -> Vec<CommitRequest> {
    let mut requests = vec![put(type_id, id)];
    requests.extend(value.chunks(PART_BYTES).map(chunk));
    requests
}

/// `requests` pushed, in order, into a batch of the bundle `a`, then finished.
fn batch(requests: Vec<CommitRequest>) -> Result<Items, ContractError> {
    let mut batch = Batch::new("a");
    for request in requests {
        batch.push(request)?;
    }
    batch.finish()
}

fn refused(requests: Vec<CommitRequest>) -> ContractError {
    batch(requests).expect_err("the batch is refused")
}

fn limit(error: &ContractError) -> Option<String> {
    detail_str(error, "limit")
}

/// A type id of 129 bytes in the bundle's namespace.
fn long_type() -> String {
    format!("a.{}", "x".repeat(127))
}

/// `requests` checked as one batch of `a`, then applied with `clock`.
async fn commit_with(
    engine: &SqliteEngine,
    clock: &Clock,
    requests: Vec<CommitRequest>,
) -> Result<f64, ContractError> {
    let items = batch(requests).expect("the batch is valid");
    apply(
        engine,
        clock,
        &Pools::default(),
        &crate::cache::Headers::default(),
        items,
    )
    .await
}

async fn commit(engine: &SqliteEngine, requests: Vec<CommitRequest>) -> Result<f64, ContractError> {
    commit_with(engine, &Clock::default(), requests).await
}

/// The value of the store's `key`, or `None`.
async fn value_of(engine: &SqliteEngine, key: Vec<u8>) -> Option<Vec<u8>> {
    engine
        .read(move |txn| txn.get(&key))
        .await
        .expect("the read succeeds")
        .map(|(value, _)| value)
}

/// The stored header of `(type_id, id)` under `a`.
async fn header(engine: &SqliteEngine, type_id: &str, id: &str) -> Option<DocumentHeader> {
    let bytes = value_of(engine, layout::document("a", type_id, id)).await?;
    Some(DocumentHeader::decode(bytes.as_slice()).expect("a header"))
}

/// The keys of `range`.
async fn keys_in(engine: &SqliteEngine, range: KeyRange) -> Vec<Vec<u8>> {
    engine
        .read(move |txn| {
            let mut found = Vec::new();
            txn.range(&range, &mut |entry| {
                found.push(entry.key.to_vec());
                ControlFlow::Continue(())
            })?;
            Ok(found)
        })
        .await
        .expect("the read succeeds")
}

/// The revision and the value `documents::get` answers for `(type_id, id)`
/// under `a`, or `None` when it emits nothing.
async fn read(engine: &SqliteEngine, type_id: &str, id: &str) -> Option<(f64, Vec<u8>)> {
    let request = GetRequest {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
    };
    let items = engine
        .read(move |txn| {
            let mut items = Vec::new();
            documents::get(txn, "a", &request, &mut |response| {
                items.push(response.item.expect("an item"));
                ControlFlow::Continue(())
            })?;
            Ok(items)
        })
        .await
        .expect("the get succeeds");
    let mut items = items.into_iter();
    let revision = match items.next()? {
        get_response::Item::Document(document) => document.revision,
        get_response::Item::Chunk(_) => panic!("a chunk before the document"),
    };
    let value = items
        .flat_map(|item| match item {
            get_response::Item::Chunk(bytes) => bytes,
            get_response::Item::Document(_) => panic!("a second document"),
        })
        .collect();
    Some((revision, value))
}

/// The position of a write of its own, outside `a`'s prefix.
async fn probe(engine: &SqliteEngine) -> f64 {
    engine
        .write(|txn| txn.put(b"z/probe", b""))
        .await
        .expect("the probe is written")
        .1
}

#[test]
fn each_stream_item_is_refused() {
    let items = [
        Item::DropStream("a.s/v1".to_owned()),
        Item::Truncate(StreamTruncate {
            stream: "a.s/v1".to_owned(),
            after_sequence: 1.0,
        }),
        Item::Append(StreamAppend {
            stream: "a.s/v1".to_owned(),
            expected_sequence: None,
        }),
        Item::Event(b"e".to_vec()),
    ];
    for item in items {
        let error = refused(vec![request(item)]);

        assert_eq!(error.code, "invalid_input");
        assert_eq!(error.message, "Stream items are not supported.");
    }
}

#[test]
fn an_item_with_no_case_is_invalid_input() {
    let error = refused(vec![CommitRequest { item: None }]);

    assert_eq!(error.code, "invalid_input");
}

#[test]
fn a_chunk_that_follows_no_put_is_invalid_input() {
    let batches = [
        vec![chunk(b"v")],
        vec![expect(NOTE, "n1", 0.0), chunk(b"v")],
        vec![put(NOTE, "n1"), delete(NOTE, "n2"), chunk(b"v")],
    ];
    for requests in batches {
        assert_eq!(refused(requests).code, "invalid_input");
    }
}

#[test]
fn a_type_of_another_namespace_is_not_owner_in_each_item() {
    for request in [
        expect("b.x/v1", "1", 0.0),
        put("b.x/v1", "1"),
        delete("b.x/v1", "1"),
    ] {
        let error = refused(vec![request]);

        assert_eq!(error.code, "not_owner");
        assert_eq!(detail_str(&error, "type").as_deref(), Some("b.x/v1"));
    }
}

#[test]
fn a_long_type_or_id_is_invalid_input_in_each_item() {
    let id = "i".repeat(layout::ID_BYTES + 1);
    for request in [
        expect(&long_type(), "1", 0.0),
        put(&long_type(), "1"),
        delete(&long_type(), "1"),
        expect(NOTE, &id, 0.0),
        put(NOTE, &id),
        delete(NOTE, &id),
    ] {
        assert_eq!(refused(vec![request]).code, "invalid_input");
    }
}

#[test]
fn an_expect_revision_must_be_a_whole_number_of_32_bits() {
    for revision in [-1.0, 1.5, f64::NAN, 4_294_967_296.0] {
        let error = refused(vec![expect(NOTE, "n1", revision)]);

        assert_eq!(error.code, "invalid_input", "revision {revision}");
    }
    for revision in [0.0, 7.0, f64::from(u32::MAX)] {
        batch(vec![expect(NOTE, "n1", revision)]).expect("a whole revision passes");
    }
}

#[test]
fn the_item_after_the_10000th_is_limit_exceeded_and_chunks_do_not_count() {
    let mut batch = Batch::new("a");
    for n in 0..ITEMS {
        batch
            .push(put(NOTE, &n.to_string()))
            .expect("an item within the limit");
        batch.push(chunk(b"v")).expect("a chunk does not count");
    }

    let error = batch
        .push(put(NOTE, "last"))
        .expect_err("the 10,001st item is refused");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("batch"));
}

#[test]
fn a_value_over_16_mib_is_limit_exceeded_for_its_document() {
    let part = vec![7; PART_BYTES];
    let mut batch = Batch::new("a");
    batch.push(put(NOTE, "n1")).expect("a put");
    for _ in 0..DOCUMENT_BYTES / PART_BYTES {
        batch.push(chunk(&part)).expect("16 MiB pass");
    }

    let error = batch.push(chunk(b"v")).expect_err("one more byte");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("document"));
}

#[test]
fn values_over_64_mib_are_limit_exceeded_for_the_batch() {
    let part = vec![7; PART_BYTES];
    let mut batch = Batch::new("a");
    for n in 0..BATCH_BYTES / DOCUMENT_BYTES {
        batch.push(put(NOTE, &n.to_string())).expect("a put");
        for _ in 0..DOCUMENT_BYTES / PART_BYTES {
            batch.push(chunk(&part)).expect("64 MiB pass");
        }
    }
    batch.push(put(NOTE, "last")).expect("a put");

    let error = batch.push(chunk(b"v")).expect_err("one more byte");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("batch"));
}

#[test]
fn a_chunk_of_no_byte_or_over_1_mib_is_invalid_input() {
    for bytes in [Vec::new(), vec![7; PART_BYTES + 1]] {
        let error = refused(vec![put(NOTE, "n1"), chunk(&bytes)]);

        assert_eq!(error.code, "invalid_input", "{} bytes", bytes.len());
    }
}

#[test]
fn an_empty_batch_is_invalid_input_and_an_expect_alone_passes() {
    let error = Batch::new("a").finish().expect_err("no item");
    assert_eq!(error.code, "invalid_input");

    batch(vec![expect(NOTE, "n1", 0.0)]).expect("an expect-only batch passes");
}

#[test]
fn the_clock_never_goes_back() {
    let clock = Clock::default();

    assert_eq!(clock.tick(100), 100);
    assert_eq!(clock.tick(50), 100);
    assert_eq!(clock.clone().tick(70), 100);
}

#[test]
fn iso_writes_as_javascript_does() {
    assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
}
