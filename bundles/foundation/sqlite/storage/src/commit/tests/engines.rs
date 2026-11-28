//! S78d: two engines on one file, each a process of its own, take turns: no
//! put or append of the other engine is lost or taken twice (T4.3, AC4).

use super::*;
use crate::{
    layout::StreamEntryHeader,
    testing::{NOTE_INDEXES, TempDir, documents_set, note, register_documents},
};

/// The stream the engines append to.
const STREAM: &str = "a.s/k";

#[tokio::test]
async fn puts_of_two_engines_in_turn_each_take_the_last_revision_plus_1() {
    let dir = TempDir::new();
    let a = doric_sqlite::open(dir.path()).expect("open A");
    let b = doric_sqlite::open(dir.path()).expect("open B");
    register_documents(&a, documents_set(NOTE_INDEXES)).await;

    commit(&a, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("A puts n1");
    commit(&b, put_value(NOTE, "n1", &note("T1", "y")))
        .await
        .expect("B puts n1");
    commit(&a, put_value(NOTE, "n1", &note("T1", "z")))
        .await
        .expect("A puts n1 again");

    assert_eq!(
        read(&a, NOTE, "n1").await,
        Some((3.0, note("T1", "z"))),
        "n1 is at revision 3 with A's last value"
    );
    let mut requests = vec![expect(NOTE, "n1", 3.0)];
    requests.extend(put_value(NOTE, "n1", &note("T1", "w")));
    let expected = commit(&a, requests).await;
    assert!(expected.is_ok(), "{expected:?}");
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn appends_of_two_engines_in_turn_take_consecutive_sequences() {
    let dir = TempDir::new();
    let a = doric_sqlite::open(dir.path()).expect("open A");
    let b = doric_sqlite::open(dir.path()).expect("open B");

    commit(&a, vec![append(STREAM, None), event(b"a1")])
        .await
        .expect("A appends a1");
    commit(&b, vec![append(STREAM, None), event(b"b2")])
        .await
        .expect("B appends b2");
    commit(&a, vec![append(STREAM, None), event(b"a3")])
        .await
        .expect("A appends a3");

    let entries = keys_in(&a, layout::under("a", &["stream.entry", STREAM])).await;
    let sequences: Vec<Vec<u8>> = (1..=3).map(|n| layout::entry("a", STREAM, n)).collect();
    assert_eq!(
        entries, sequences,
        "the entries are 1 to 3, with no gap or duplicate"
    );
    for (n, event) in (1..=3).zip([&b"a1"[..], b"b2", b"a3"]) {
        let stored = value_of(&a, layout::entry("a", STREAM, n))
            .await
            .expect("the entry is stored");
        let header = StreamEntryHeader::decode(stored.as_slice()).expect("an entry header");
        assert_eq!(header.chunk, event, "entry {n}");
    }
    let expected = commit(&a, vec![append(STREAM, Some(3.0)), event(b"a4")]).await;
    assert!(expected.is_ok(), "{expected:?}");
    a.close().await;
    b.close().await;
}
