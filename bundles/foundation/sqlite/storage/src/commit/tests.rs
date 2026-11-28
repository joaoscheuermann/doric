//! S77a3a: `Commit`'s checks as the items arrive (C1–C11), the clock (C24),
//! and, in [`apply`] and [`conflicts`], the batch applied to a store; S78a:
//! the checks of stream items (R2).

mod apply;
mod conflicts;

use std::ops::ControlFlow;

use doric_sqlite::{KeyRange, SqliteEngine};
use prost::Message as _;

use super::*;
use crate::{
    documents,
    layout::{self, DocumentHeader},
    testing::{NOTE, PLAIN, detail_str},
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

fn append(stream: &str, expected: Option<f64>) -> CommitRequest {
    request(Item::Append(StreamAppend {
        stream: stream.to_owned(),
        expected_sequence: expected,
    }))
}

fn event(bytes: &[u8]) -> CommitRequest {
    request(Item::Event(bytes.to_vec()))
}

fn truncate(stream: &str, after: f64) -> CommitRequest {
    request(Item::Truncate(StreamTruncate {
        stream: stream.to_owned(),
        after_sequence: after,
    }))
}

fn drop_stream(stream: &str) -> CommitRequest {
    request(Item::DropStream(stream.to_owned()))
}

/// An event of `len` bytes: an `event` item of at most [`PART_BYTES`], then
/// `chunk` items.
fn sized_event(len: usize) -> Vec<CommitRequest> {
    let value = vec![7_u8; len];
    let mut parts = value.chunks(PART_BYTES);
    let mut requests = vec![event(parts.next().expect("a first part"))];
    requests.extend(parts.map(chunk));
    requests
}

#[test]
fn each_stream_item_is_taken() {
    let items = batch(vec![
        drop_stream("a.s/v1"),
        truncate("a.s/v2", 1.0),
        append("a.s/v1", None),
        event(b"e"),
        chunk(b"more"),
        event(b"f"),
        append("a.s/v3", Some(2.0)),
        event(b"g"),
    ]);

    assert!(items.is_ok(), "{items:?}");
}

#[test]
fn an_event_that_follows_no_append_is_invalid_input() {
    let batches = [
        vec![event(b"e")],
        vec![put(NOTE, "n1"), event(b"e")],
        vec![truncate("a.s/v1", 0.0), event(b"e")],
        vec![drop_stream("a.s/v1"), event(b"e")],
    ];
    for requests in batches {
        assert_eq!(refused(requests).code, "invalid_input");
    }
    assert!(batch(vec![append("a.s/v1", None), event(b"e")]).is_ok());
}

#[test]
fn a_chunk_after_an_event_extends_it_and_after_an_append_is_invalid_input() {
    assert!(batch(vec![append("a.s/v1", None), event(b"e"), chunk(b"f")]).is_ok());

    let error = refused(vec![append("a.s/v1", None), chunk(b"f")]);
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn an_event_of_no_byte_or_over_1_mib_is_invalid_input() {
    for bytes in [Vec::new(), vec![0; PART_BYTES + 1]] {
        let error = refused(vec![append("a.s/v1", None), event(&bytes)]);

        assert_eq!(error.code, "invalid_input", "{} bytes", bytes.len());
    }
    for bytes in [vec![0; 1], vec![0; PART_BYTES]] {
        let taken = batch(vec![append("a.s/v1", None), event(&bytes)]);

        assert!(taken.is_ok(), "{} bytes: {taken:?}", bytes.len());
    }
}

#[test]
fn a_second_truncate_in_one_batch_is_invalid_input() {
    for second in ["a.s/v1", "a.s/v2"] {
        let error = refused(vec![truncate("a.s/v1", 0.0), truncate(second, 0.0)]);

        assert_eq!(error.code, "invalid_input", "{second}");
    }
    assert!(batch(vec![truncate("a.s/v1", 0.0), drop_stream("a.s/v2")]).is_ok());
}

#[test]
fn a_sequence_that_is_not_a_whole_number_of_32_bits_is_invalid_input() {
    for sequence in [1.5, -1.0, f64::NAN, f64::from(u32::MAX) + 1.0] {
        let truncated = refused(vec![truncate("a.s/v1", sequence)]);
        let appended = refused(vec![append("a.s/v1", Some(sequence)), event(b"e")]);

        assert_eq!(truncated.code, "invalid_input", "truncate {sequence}");
        assert_eq!(appended.code, "invalid_input", "append {sequence}");
    }
    assert!(batch(vec![truncate("a.s/v1", f64::from(u32::MAX))]).is_ok());
}

#[test]
fn each_stream_item_checks_its_stream_id() {
    let items = |stream: &str| {
        vec![
            vec![drop_stream(stream)],
            vec![truncate(stream, 0.0)],
            vec![append(stream, None), event(b"e")],
        ]
    };
    for requests in items("b.s/v1") {
        let error = refused(requests);

        assert_eq!(error.code, "not_owner");
        assert_eq!(detail_str(&error, "stream").as_deref(), Some("b.s/v1"));
    }
    for requests in items("a.s/") {
        assert_eq!(refused(requests).code, "invalid_stream");
    }
}

#[test]
fn an_event_of_3_mib_is_taken_and_one_byte_more_is_limit_exceeded_for_the_append() {
    let mut largest = vec![append("a.s/v1", None)];
    largest.extend(sized_event(APPEND_BYTES));
    assert!(batch(largest).is_ok());

    let mut over = vec![append("a.s/v1", None)];
    over.extend(sized_event(APPEND_BYTES + 1));
    let error = refused(over);

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("append"));
}

#[test]
fn events_count_toward_the_batch_limits_and_appends_do_not() {
    let mut batch = Batch::new("a");
    batch.push(append("a.s/v1", None)).expect("the append");
    for n in 0..ITEMS {
        batch
            .push(event(b"e"))
            .unwrap_or_else(|error| panic!("event {n}: {error:?}"));
    }
    batch
        .push(append("a.s/v2", None))
        .expect("an append does not count");

    let error = batch
        .push(event(b"e"))
        .expect_err("the item after the 10000th");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("batch"));
}

#[test]
fn the_bytes_of_events_count_toward_the_batch() {
    let mut requests = Vec::new();
    for n in 0..4 {
        requests.extend(put_value(PLAIN, &format!("p{n}"), &vec![1; DOCUMENT_BYTES]));
    }
    requests.extend([append("a.s/v1", None), event(b"e")]);

    let error = refused(requests);

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(limit(&error).as_deref(), Some("batch"));
}

#[test]
fn an_append_with_no_event_is_invalid_input() {
    let followed = [
        put(PLAIN, "p1"),
        expect(PLAIN, "p1", 0.0),
        delete(PLAIN, "p1"),
        drop_stream("a.s/v2"),
        truncate("a.s/v2", 0.0),
        append("a.s/v2", None),
    ];
    for next in followed {
        let error = refused(vec![append("a.s/v1", None), next]);

        assert_eq!(error.code, "invalid_input");
        assert_eq!(error.message, "An append needs at least one event.");
        assert_eq!(detail_str(&error, "stream").as_deref(), Some("a.s/v1"));
    }

    let error = refused(vec![put(PLAIN, "p1"), append("a.s/v1", None)]);
    assert_eq!(error.code, "invalid_input");
    assert_eq!(error.message, "An append needs at least one event.");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some("a.s/v1"));
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
