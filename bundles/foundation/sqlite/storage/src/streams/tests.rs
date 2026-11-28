//! S78a: stream ids (R1), a batch's stream items applied to a store (R3),
//! `Read`'s checks and pages (R4), and the keys of stream records (R5).

use std::ops::ControlFlow;

use doric_sqlite::{KeyRange, KvEngine as _, SqliteEngine};
use prost::Message as _;

use super::*;
use crate::{
    commit::{self, Batch, Clock, PART_BYTES},
    layout::{self, DocumentHeader},
    schema::Pools,
    testing::{PLAIN, detail_num, detail_str, documents_store, open_temp},
    v2::{
        CommitRequest, DocumentKey, StreamAppend, StreamRead, StreamTruncate, commit_request::Item,
        read_response,
    },
};

const STREAM: &str = "a.s/k";
const OTHER: &str = "a.s/other";

fn request(item: Item) -> CommitRequest {
    CommitRequest { item: Some(item) }
}

/// An append to `stream`, expecting `expected` when it is `Some`, of
/// `events`, each in one `event` item.
fn append(stream: &str, expected: Option<f64>, events: &[&[u8]]) -> Vec<CommitRequest> {
    let mut requests = vec![request(Item::Append(StreamAppend {
        stream: stream.to_owned(),
        expected_sequence: expected,
    }))];
    requests.extend(
        events
            .iter()
            .map(|event| request(Item::Event(event.to_vec()))),
    );
    requests
}

/// An append to `stream` of one event `value`, in an `event` item and
/// `chunk` items of at most [`PART_BYTES`].
fn append_large(stream: &str, value: &[u8]) -> Vec<CommitRequest> {
    let mut parts = value.chunks(PART_BYTES);
    let mut requests = append(stream, None, &[parts.next().expect("a first part")]);
    requests.extend(parts.map(|part| request(Item::Chunk(part.to_vec()))));
    requests
}

fn truncate(stream: &str, after: f64) -> Vec<CommitRequest> {
    vec![request(Item::Truncate(StreamTruncate {
        stream: stream.to_owned(),
        after_sequence: after,
    }))]
}

fn drop_stream(stream: &str) -> Vec<CommitRequest> {
    vec![request(Item::DropStream(stream.to_owned()))]
}

/// A put of the plain document `id` with the value `value`.
fn put(id: &str, value: &[u8]) -> Vec<CommitRequest> {
    vec![
        request(Item::Put(DocumentKey {
            r#type: PLAIN.to_owned(),
            id: id.to_owned(),
        })),
        request(Item::Chunk(value.to_vec())),
    ]
}

/// The items of `parts`, in order, committed as one batch of `a`.
async fn commit(
    engine: &SqliteEngine,
    parts: Vec<Vec<CommitRequest>>,
) -> Result<f64, ContractError> {
    let mut batch = Batch::new("a");
    for request in parts.into_iter().flatten() {
        batch.push(request)?;
    }
    let items = batch.finish()?;
    commit::apply(
        engine,
        &Clock::default(),
        &Pools::default(),
        &crate::watch::Watchers::default(),
        items,
    )
    .await
}

fn read_request(stream: &str, after: f64, limit: i32) -> ReadRequest {
    ReadRequest {
        stream_read: Some(StreamRead {
            stream: stream.to_owned(),
            after_sequence: after,
            limit,
        }),
    }
}

/// One entry of a [`Page`]: its sequence, its `createdAt` and its event, the
/// concatenation of its chunks.
#[derive(Debug, Clone, PartialEq)]
struct Entry {
    sequence: f64,
    created_at: String,
    value: Vec<u8>,
}

/// What a `Read` emitted: the page's head, then its entries; and every chunk
/// size, to check each against the contract's bound.
#[derive(Debug, Clone, PartialEq)]
struct Page {
    last_sequence: f64,
    truncations: Vec<(f64, f64)>,
    entries: Vec<Entry>,
    chunk_sizes: Vec<usize>,
}

impl Page {
    fn sequences(&self) -> Vec<f64> {
        self.entries.iter().map(|entry| entry.sequence).collect()
    }
}

/// `check` then `read` of `a`'s `stream` after `after`, at most `limit`
/// entries, in one read transaction of `engine`.
async fn page(
    engine: &SqliteEngine,
    stream: &str,
    after: f64,
    limit: i32,
) -> Result<Page, ContractError> {
    let checked = check("a", &read_request(stream, after, limit))?;
    engine
        .read(move |txn| {
            let mut items = Vec::new();
            super::read(txn, "a", &checked, &mut |response| {
                items.push(response.item.expect("an item"));
                ControlFlow::Continue(())
            })?;
            Ok(items)
        })
        .await
        .map(|items| {
            let mut items = items.into_iter();
            let Some(read_response::Item::Page(head)) = items.next() else {
                panic!("the first item is not the page");
            };
            let mut page = Page {
                last_sequence: head.last_sequence,
                truncations: head
                    .truncations
                    .iter()
                    .map(|mark| (mark.after_sequence, mark.at_sequence))
                    .collect(),
                entries: Vec::new(),
                chunk_sizes: Vec::new(),
            };
            for item in items {
                match item {
                    read_response::Item::Page(_) => panic!("a second page"),
                    read_response::Item::Entry(entry) => page.entries.push(Entry {
                        sequence: entry.sequence,
                        created_at: entry.created_at,
                        value: Vec::new(),
                    }),
                    read_response::Item::Chunk(bytes) => {
                        page.chunk_sizes.push(bytes.len());
                        page.entries
                            .last_mut()
                            .expect("a chunk after an entry")
                            .value
                            .extend_from_slice(&bytes);
                    }
                }
            }
            page
        })
}

/// Every key of the store, in key order.
async fn all_keys(engine: &SqliteEngine) -> Vec<Vec<u8>> {
    let range = KeyRange {
        start: Vec::new(),
        end: vec![0xFF],
        ..KeyRange::default()
    };
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

/// `len` bytes that are not all equal.
fn bytes(len: usize) -> Vec<u8> {
    (0..len)
        .map(|n| u8::try_from(n % 251).expect("below 251"))
        .collect()
}

// R1: stream ids.

#[test]
fn a_stream_id_of_the_owner_is_valid() {
    assert_eq!(checked("a", "a.b/k"), Ok(()));
    assert_eq!(checked("a", "a.b.c-d/k/with/slashes"), Ok(()));
}

#[test]
fn an_id_not_of_the_form_owner_family_key_is_invalid_stream() {
    for stream in [
        "a/k",
        "A.b/k",
        "a.b/",
        "a.b/x y",
        "a.b/x\u{FEFF}",
        "a.b/x\ty",
        "",
    ] {
        let error = checked("a", stream).expect_err(stream);

        assert_eq!(error.code, "invalid_stream", "{stream:?}");
        assert_eq!(detail_str(&error, "stream").as_deref(), Some(stream));
    }
}

#[test]
fn next_line_is_not_whitespace_in_a_key() {
    assert_eq!(checked("a", "a.b/x\u{0085}"), Ok(()));
}

#[test]
fn an_id_over_512_bytes_is_invalid_input_before_its_form() {
    let at_limit = format!("a.b/{}", "k".repeat(STREAM_ID_BYTES - 4));
    let over = format!("a.b/{}", "k".repeat(STREAM_ID_BYTES - 3));
    let malformed_over = format!("a b/{}", "k".repeat(STREAM_ID_BYTES));

    assert_eq!(checked("a", &at_limit), Ok(()));
    for stream in [over, malformed_over] {
        let error = checked("a", &stream).expect_err("over the limit");
        assert_eq!(error.code, "invalid_input");
        assert_eq!(
            detail_str(&error, "stream").as_deref(),
            Some(stream.as_str())
        );
    }
}

#[test]
fn a_stream_of_another_bundle_is_not_owner() {
    let error = checked("a", "other.b/k").expect_err("another owner");

    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some("other.b/k"));
}

#[test]
fn a_malformed_stream_of_another_bundle_is_invalid_stream_before_not_owner() {
    let error = checked("a", "other.b/").expect_err("malformed");

    assert_eq!(error.code, "invalid_stream");
}

// R4: `Read`'s checks, before any I/O.

#[test]
fn a_read_with_no_stream_read_is_invalid_input() {
    let error = check("a", &ReadRequest { stream_read: None }).expect_err("no read");

    assert_eq!(error.code, "invalid_input");
}

#[test]
fn a_read_checks_its_stream_then_its_after_sequence_then_its_limit() {
    let cases = [
        (read_request("other.s/k", 0.0, 1), "not_owner"),
        (read_request("a.s/", 0.0, 1), "invalid_stream"),
        (read_request("other.s/k", 1.5, 0), "not_owner"),
        (read_request(STREAM, 1.5, 1), "invalid_input"),
        (read_request(STREAM, -1.0, 1), "invalid_input"),
        (read_request(STREAM, 0.0, 0), "invalid_input"),
        (read_request(STREAM, 0.0, -1), "invalid_input"),
    ];
    for (request, code) in cases {
        let error = check("a", &request).expect_err("refused");

        assert_eq!(error.code, code, "{request:?}");
    }
    assert!(check("a", &read_request(STREAM, 0.0, 1)).is_ok());
}

// R4: pages.

#[tokio::test]
async fn an_absent_stream_reads_an_empty_page_at_0() {
    let (_dir, engine) = open_temp();

    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");

    assert_eq!(
        read,
        Page {
            last_sequence: 0.0,
            truncations: Vec::new(),
            entries: Vec::new(),
            chunk_sizes: Vec::new(),
        }
    );
}

#[tokio::test]
async fn a_page_holds_at_most_its_limit_of_the_entries_after_its_cursor() {
    let (_dir, engine) = open_temp();
    commit(
        &engine,
        vec![append(STREAM, None, &[b"1", b"2", b"3", b"4", b"5"])],
    )
    .await
    .expect("five events");

    let read = page(&engine, STREAM, 1.0, 2).await.expect("the read");

    assert_eq!(read.last_sequence, 5.0);
    assert_eq!(read.sequences(), vec![2.0, 3.0]);
    let values: Vec<_> = read
        .entries
        .iter()
        .map(|entry| entry.value.clone())
        .collect();
    assert_eq!(values, vec![b"2".to_vec(), b"3".to_vec()]);
}

#[tokio::test]
async fn a_page_lists_the_marks_with_after_below_its_cursor_up_to_at_in_commit_order() {
    let (_dir, engine) = open_temp();
    commit(
        &engine,
        vec![append(STREAM, None, &[b"1", b"2", b"3", b"4", b"5"])],
    )
    .await
    .expect("five events");
    commit(&engine, vec![truncate(STREAM, 3.0)])
        .await
        .expect("a mark {3, 5}");
    commit(&engine, vec![append(STREAM, None, &[b"6", b"7"])])
        .await
        .expect("two events more");
    commit(&engine, vec![truncate(STREAM, 1.0)])
        .await
        .expect("a mark {1, 7}");

    let marks = |after: f64| {
        let engine = &engine;
        async move {
            page(engine, STREAM, after, 10)
                .await
                .expect("the read")
                .truncations
        }
    };
    assert_eq!(marks(4.0).await, vec![(3.0, 5.0), (1.0, 7.0)]);
    assert_eq!(marks(6.0).await, vec![(1.0, 7.0)]);
    assert_eq!(marks(7.0).await, vec![(1.0, 7.0)]);
    assert_eq!(marks(1.0).await, Vec::<(f64, f64)>::new());
    assert_eq!(marks(0.0).await, Vec::<(f64, f64)>::new());
    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(read.sequences(), vec![1.0]);
    assert_eq!(read.last_sequence, 7.0);
}

#[tokio::test]
async fn reading_after_the_last_sequence_is_invalid_input_with_its_details() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(STREAM, None, &[b"1", b"2"])])
        .await
        .expect("two events");

    let error = page(&engine, STREAM, 3.0, 10)
        .await
        .expect_err("past the end");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some(STREAM));
    assert_eq!(detail_num(&error, "afterSequence"), Some(3.0));
    assert_eq!(detail_num(&error, "lastSequence"), Some(2.0));
    assert!(page(&engine, STREAM, 2.0, 10).await.is_ok());
}

#[tokio::test]
async fn an_entry_over_one_record_reads_back_whole_in_chunks_of_at_most_1_mib() {
    let (_dir, engine) = open_temp();
    let value = bytes(layout::CHUNK_BYTES * 2 + 17);
    commit(&engine, vec![append_large(STREAM, &value)])
        .await
        .expect("one large event");

    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");

    assert_eq!(read.sequences(), vec![1.0]);
    assert_eq!(read.entries[0].value, value);
    assert!(read.chunk_sizes.len() >= 2, "{:?}", read.chunk_sizes);
    for size in &read.chunk_sizes {
        assert!((1..=PART_BYTES).contains(size), "a chunk of {size} bytes");
    }
}

// R3: a batch's stream items applied to a store.

#[tokio::test]
async fn two_appends_to_one_stream_in_one_batch_continue_each_other() {
    let (_dir, engine) = open_temp();

    commit(
        &engine,
        vec![
            append(STREAM, None, &[b"a"]),
            append(OTHER, None, &[b"x"]),
            append(STREAM, Some(1.0), &[b"b", b"c"]),
        ],
    )
    .await
    .expect("the appends commit");

    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(read.sequences(), vec![1.0, 2.0, 3.0]);
    assert_eq!(read.last_sequence, 3.0);
    assert_eq!(
        page(&engine, OTHER, 0.0, 10)
            .await
            .expect("the read")
            .sequences(),
        vec![1.0]
    );
}

#[tokio::test]
async fn a_truncate_then_an_append_marks_the_head_after_the_appends() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(STREAM, None, &[b"1", b"2", b"3"])])
        .await
        .expect("three events");

    commit(
        &engine,
        vec![append(STREAM, None, &[b"4", b"5"]), truncate(STREAM, 1.0)],
    )
    .await
    .expect("the truncate and the append commit");

    let read = page(&engine, STREAM, 3.0, 10).await.expect("the read");
    assert_eq!(read.last_sequence, 5.0);
    assert_eq!(read.truncations, vec![(1.0, 5.0)]);
    assert_eq!(read.sequences(), vec![4.0, 5.0]);
    let whole = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(whole.sequences(), vec![1.0, 4.0, 5.0]);
}

#[tokio::test]
async fn a_truncate_of_a_stream_the_batch_dropped_is_invalid_input_and_writes_nothing() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(STREAM, None, &[b"1", b"2"])])
        .await
        .expect("two events");

    let error = commit(&engine, vec![truncate(STREAM, 1.0), drop_stream(STREAM)])
        .await
        .expect_err("the stream is dropped before the truncate");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some(STREAM));
    assert_eq!(detail_num(&error, "afterSequence"), Some(1.0));
    assert_eq!(detail_num(&error, "lastSequence"), Some(0.0));
    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(read.sequences(), vec![1.0, 2.0]);
}

#[tokio::test]
async fn a_truncate_past_the_last_sequence_is_invalid_input_with_its_details() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(STREAM, None, &[b"1", b"2"])])
        .await
        .expect("two events");

    let error = commit(&engine, vec![truncate(STREAM, 3.0)])
        .await
        .expect_err("past the end");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(detail_num(&error, "afterSequence"), Some(3.0));
    assert_eq!(detail_num(&error, "lastSequence"), Some(2.0));
}

#[tokio::test]
async fn an_unmet_expected_sequence_is_sequence_conflict_and_writes_nothing() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, vec![append(STREAM, None, &[b"1"])])
        .await
        .expect("one event");
    let before = all_keys(&engine).await;

    let error = commit(
        &engine,
        vec![
            put("p1", b"v"),
            append(OTHER, None, &[b"x"]),
            append(STREAM, Some(3.0), &[b"2"]),
        ],
    )
    .await
    .expect_err("the stream is at 1");

    assert_eq!(error.code, "sequence_conflict");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some(STREAM));
    assert_eq!(detail_num(&error, "expected"), Some(3.0));
    assert_eq!(detail_num(&error, "actual"), Some(1.0));
    assert_eq!(all_keys(&engine).await, before);
}

#[tokio::test]
async fn an_entry_takes_its_commits_updated_at_as_created_at() {
    let (_dir, engine) = documents_store().await;

    commit(
        &engine,
        vec![put("p1", b"v"), append(STREAM, None, &[b"1"])],
    )
    .await
    .expect("the put and the append commit");

    let key = layout::document("a", PLAIN, "p1");
    let (stored, _) = engine
        .read(move |txn| txn.get(&key))
        .await
        .expect("the read succeeds")
        .expect("the header is stored");
    let header = DocumentHeader::decode(stored.as_slice()).expect("a header");
    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(read.entries[0].created_at, header.updated_at);
}

#[tokio::test]
async fn a_drop_then_an_append_in_one_batch_starts_the_stream_again_at_1() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(STREAM, None, &[b"1", b"2"])])
        .await
        .expect("two events");
    commit(&engine, vec![truncate(STREAM, 1.0)])
        .await
        .expect("a mark");

    commit(
        &engine,
        vec![append(STREAM, Some(0.0), &[b"b"]), drop_stream(STREAM)],
    )
    .await
    .expect("the drop applies before the append");

    let read = page(&engine, STREAM, 0.0, 10).await.expect("the read");
    assert_eq!(read.sequences(), vec![1.0]);
    assert_eq!(read.last_sequence, 1.0);
    assert_eq!(read.truncations, Vec::<(f64, f64)>::new());
    assert_eq!(read.entries[0].value, b"b".to_vec());
}

// R5: the keys of stream records.

#[tokio::test]
async fn every_key_a_stream_writes_is_under_its_bundles_prefix() {
    let (_dir, engine) = open_temp();
    let before = all_keys(&engine).await;

    commit(
        &engine,
        vec![append_large(STREAM, &bytes(layout::CHUNK_BYTES + 1))],
    )
    .await
    .expect("a large event");
    commit(&engine, vec![append(STREAM, None, &[b"2", b"3"])])
        .await
        .expect("two events");
    commit(&engine, vec![truncate(STREAM, 2.0)])
        .await
        .expect("a mark");

    let written: Vec<_> = all_keys(&engine)
        .await
        .into_iter()
        .filter(|key| !before.contains(key))
        .collect();
    // A head, two entries, one chunk and one mark.
    assert!(written.len() >= 5, "{} keys", written.len());
    for key in &written {
        assert!(key.starts_with(b"a/"), "{key:?}");
    }
}

#[tokio::test]
async fn a_dropped_stream_leaves_no_key() {
    let (_dir, engine) = open_temp();
    commit(&engine, vec![append(OTHER, None, &[b"kept"])])
        .await
        .expect("another stream");
    let before = all_keys(&engine).await;
    commit(
        &engine,
        vec![append_large(STREAM, &bytes(layout::CHUNK_BYTES + 1))],
    )
    .await
    .expect("a large event");
    commit(&engine, vec![append(STREAM, None, &[b"2"])])
        .await
        .expect("an event");
    commit(&engine, vec![truncate(STREAM, 1.0)])
        .await
        .expect("a mark");

    commit(&engine, vec![drop_stream(STREAM)])
        .await
        .expect("the drop");

    assert_eq!(all_keys(&engine).await, before);
    assert_eq!(
        page(&engine, OTHER, 0.0, 10)
            .await
            .expect("the read")
            .sequences(),
        vec![1.0]
    );
}
