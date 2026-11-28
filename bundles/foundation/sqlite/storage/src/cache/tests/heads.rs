//! S78a: stream heads in the header cache: a rolled-back append (R6), two
//! engines appending to one stream (R7), and what the cache holds of heads,
//! under its bound, a `storage.kv/v1` commit and a suspension (R8).

use super::*;
use crate::{
    streams,
    testing::{TempDir, documents_store, open_temp},
    v2::{ReadRequest, StreamAppend, StreamRead, read_response},
};

const STREAM: &str = "a.s/k";

/// An append to `stream`, expecting `expected` when it is `Some`, of one
/// event per item of `events`.
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

/// The last sequence of `a`'s `stream` and the sequences and events of its
/// entries, read with [`streams::read`] from 0.
async fn entries(engine: &SqliteEngine, stream: &str) -> (f64, Vec<(f64, Vec<u8>)>) {
    let request = ReadRequest {
        stream_read: Some(StreamRead {
            stream: stream.to_owned(),
            after_sequence: 0.0,
            limit: 1_000,
        }),
    };
    let read = streams::check("a", &request).expect("a valid read");
    engine
        .read(move |txn| {
            let mut last = None;
            let mut found: Vec<(f64, Vec<u8>)> = Vec::new();
            streams::read(txn, "a", &read, &mut |response| {
                match response.item.expect("an item") {
                    read_response::Item::Page(page) => last = Some(page.last_sequence),
                    read_response::Item::Entry(entry) => found.push((entry.sequence, Vec::new())),
                    read_response::Item::Chunk(bytes) => found
                        .last_mut()
                        .expect("a chunk after an entry")
                        .1
                        .extend_from_slice(&bytes),
                }
                ControlFlow::Continue(())
            })?;
            Ok((last.expect("a page"), found))
        })
        .await
        .expect("the read succeeds")
}

fn numbered(events: &[(f64, &[u8])]) -> Vec<(f64, Vec<u8>)> {
    events
        .iter()
        .map(|(sequence, event)| (*sequence, event.to_vec()))
        .collect()
}

// R6

#[tokio::test]
async fn a_rolled_back_append_leaves_the_committed_head_and_the_next_append_follows_it() {
    for bound in BOUNDS {
        let (_dir, engine) = open_temp();
        let headers = Headers::new(bound);
        commit(&engine, &headers, vec![append(STREAM, None, &[b"1"])])
            .await
            .expect("the first append");
        assert_eq!(headers.len(), cached(bound, 1), "bound {bound}");

        let error = commit(
            &engine,
            &headers,
            vec![
                append(STREAM, None, &[b"lost"]),
                append("a.s/other", Some(5.0), &[b"x"]),
            ],
        )
        .await
        .expect_err("the other stream is at 0");
        assert_eq!(error.code, "sequence_conflict", "bound {bound}");
        assert_eq!(headers.len(), cached(bound, 1), "bound {bound}");

        commit(&engine, &headers, vec![append(STREAM, Some(1.0), &[b"2"])])
            .await
            .expect("the stream is at 1");

        assert_eq!(
            entries(&engine, STREAM).await,
            (2.0, numbered(&[(1.0, b"1"), (2.0, b"2")])),
            "bound {bound}"
        );
    }
}

// R7

#[tokio::test]
async fn an_append_of_another_engine_is_continued_with_no_gap_and_no_duplicate() {
    for bound in BOUNDS {
        let dir = TempDir::new();
        let a = doric_sqlite::open(dir.path()).expect("open A");
        let b = doric_sqlite::open(dir.path()).expect("open B");
        let (on_a, on_b) = (Headers::new(bound), Headers::new(bound));

        commit(&a, &on_a, vec![append(STREAM, None, &[b"a1"])])
            .await
            .expect("A appends");
        commit(&b, &on_b, vec![append(STREAM, None, &[b"b2"])])
            .await
            .expect("B appends");
        commit(&a, &on_a, vec![append(STREAM, None, &[b"a3"])])
            .await
            .expect("A appends again");

        assert_eq!(
            entries(&a, STREAM).await,
            (3.0, numbered(&[(1.0, b"a1"), (2.0, b"b2"), (3.0, b"a3")])),
            "bound {bound}"
        );
        let expected = commit(&a, &on_a, vec![append(STREAM, Some(3.0), &[b"a4"])]).await;
        assert!(expected.is_ok(), "bound {bound}: {expected:?}");
        a.close().await;
        b.close().await;
    }
}

// R8

#[tokio::test]
async fn a_head_counts_its_key_and_entry_bytes() {
    let (_dir, engine) = open_temp();
    let headers = Headers::new(ON);

    commit(&engine, &headers, vec![append(STREAM, None, &[b"1"])])
        .await
        .expect("an append");

    assert_eq!(headers.len(), 1);
    assert_eq!(
        headers.bytes(),
        layout::head("a", STREAM).len() + ENTRY_BYTES
    );
}

#[tokio::test]
async fn heads_and_headers_share_the_bound_and_an_evicted_head_is_read_again() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("a note");
    for n in 0..100 {
        commit(
            &engine,
            &headers,
            vec![append(&format!("a.s/k{n:03}"), None, &[b"1"])],
        )
        .await
        .expect("an append");
    }

    assert!(headers.bytes() <= ON, "{} bytes", headers.bytes());
    assert!(headers.len() < 101, "{} entries", headers.len());
    commit(
        &engine,
        &headers,
        vec![append("a.s/k000", Some(1.0), &[b"2"])],
    )
    .await
    .expect("the evicted stream is at 1");
    assert_eq!(entries(&engine, "a.s/k000").await.0, 2.0);
    commit(
        &engine,
        &headers,
        vec![expect("n1", 1.0), put("n1", "t1", "y")],
    )
    .await
    .expect("the evicted note is at revision 1");
}

#[tokio::test]
async fn a_kv_commit_on_the_writer_keeps_the_cached_heads() {
    let (_dir, engine) = open_temp();
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![append(STREAM, None, &[b"1"])])
        .await
        .expect("an append");

    kv_commit(&engine).await;

    assert_eq!(headers.len(), 1);
    commit(&engine, &headers, vec![append(STREAM, Some(1.0), &[b"2"])])
        .await
        .expect("the stream is at 1");
}

#[tokio::test]
async fn a_suspension_clears_the_cached_heads() {
    let (_dir, engine) = open_temp();
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![append(STREAM, None, &[b"1"])])
        .await
        .expect("an append");
    assert_eq!(headers.len(), 1);

    drop(headers.suspend());

    assert!(headers.is_empty(), "{} entries", headers.len());
    commit(&engine, &headers, vec![append(STREAM, Some(1.0), &[b"2"])])
        .await
        .expect("the stream is at 1");
}

#[tokio::test]
async fn a_bound_of_0_caches_no_head_and_answers_the_same() {
    let (_dir, engine) = open_temp();
    let headers = Headers::new(0);

    for event in [&b"1"[..], b"2", b"3"] {
        commit(&engine, &headers, vec![append(STREAM, None, &[event])])
            .await
            .expect("an append");
    }

    assert_eq!(headers.len(), 0);
    assert_eq!(headers.bytes(), 0);
    assert_eq!(
        entries(&engine, STREAM).await,
        (3.0, numbered(&[(1.0, b"1"), (2.0, b"2"), (3.0, b"3")]))
    );
}
