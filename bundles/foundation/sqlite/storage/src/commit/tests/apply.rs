//! S77a3a: a checked batch applied to a store: values, headers, revisions,
//! deletes, index keys, chunks, `updatedAt` and the prefix (C12–C15, C19,
//! C22–C25, C27, C28).

use super::*;
use crate::{
    keys::Element,
    layout::{CHUNK_BYTES, index, prefixed, under},
    testing::{
        NOTE_INDEXES, PLAIN, documents_set, documents_store, note, open_temp, register_documents,
    },
};

fn string(text: &str) -> Element {
    Element::String(text.to_owned())
}

fn by_tag(tag: &str, id: &str) -> Vec<u8> {
    index(NOTE, "byTag", &[string(tag)], Some(id)).expect("an index key")
}

fn by_title(title: &str) -> Vec<u8> {
    index(NOTE, "byTitle", &[string(title)], None).expect("an index key")
}

fn sorted(mut keys: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    keys.sort();
    keys
}

/// `len` bytes that are not all equal.
fn bytes(len: usize) -> Vec<u8> {
    (0..len)
        .map(|n| u8::try_from(n % 251).expect("below 251"))
        .collect()
}

#[tokio::test]
async fn a_put_in_three_chunks_stores_their_concatenation() {
    let (_dir, engine) = documents_store().await;

    commit(
        &engine,
        vec![put(PLAIN, "p1"), chunk(b"ab"), chunk(b"cd"), chunk(b"ef")],
    )
    .await
    .expect("the put commits");

    assert_eq!(
        read(&engine, PLAIN, "p1").await,
        Some((1.0, b"abcdef".to_vec()))
    );
}

#[tokio::test]
async fn a_new_put_writes_its_header_and_answers_the_position() {
    let (_dir, engine) = documents_store().await;
    let value = note("T1", "x");

    let position = commit(&engine, put_value(NOTE, "n1", &value))
        .await
        .expect("the put commits");

    let header = header(&engine, NOTE, "n1").await.expect("a header");
    assert_eq!(header.revision, 1);
    assert_eq!(header.value_size as usize, value.len());
    assert_eq!(header.chunk_count, 0);
    assert_eq!(header.chunk, value);
    assert_eq!(
        sorted(header.index_keys),
        sorted(vec![by_tag("x", "n1"), by_title("T1")])
    );
    assert_eq!(probe(&engine).await, position + 1.0);
}

#[tokio::test]
async fn two_puts_of_one_id_in_a_batch_take_two_revisions_and_the_last_value() {
    let (_dir, engine) = documents_store().await;

    commit(
        &engine,
        vec![
            put(PLAIN, "p1"),
            chunk(b"one"),
            put(PLAIN, "p1"),
            chunk(b"two"),
        ],
    )
    .await
    .expect("the puts commit");

    assert_eq!(
        read(&engine, PLAIN, "p1").await,
        Some((2.0, b"two".to_vec()))
    );
}

#[tokio::test]
async fn a_delete_removes_the_header_the_chunks_and_the_index_keys() {
    let (_dir, engine) = documents_store().await;
    let mut requests = put_value(NOTE, "n1", &note("T1", "x"));
    requests.extend(put_value(PLAIN, "p1", &bytes(CHUNK_BYTES + 1)));
    commit(&engine, requests).await.expect("the puts commit");

    commit(&engine, vec![delete(NOTE, "n1"), delete(PLAIN, "p1")])
        .await
        .expect("the deletes commit");

    for tuple in [["doc"], ["doc.chunk"], ["idx"]] {
        assert_eq!(
            keys_in(&engine, under("a", &tuple)).await,
            Vec::<Vec<u8>>::new()
        );
    }
    assert_eq!(read(&engine, NOTE, "n1").await, None);
}

#[tokio::test]
async fn deleting_an_absent_document_is_ok() {
    let (_dir, engine) = documents_store().await;

    commit(&engine, vec![delete(PLAIN, "absent")])
        .await
        .expect("the delete commits");

    assert_eq!(read(&engine, PLAIN, "absent").await, None);
}

#[tokio::test]
async fn a_delete_then_a_put_in_one_batch_restarts_at_revision_1() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, vec![put(PLAIN, "p1"), put(PLAIN, "p1")])
        .await
        .expect("revision 2");

    commit(
        &engine,
        vec![delete(PLAIN, "p1"), put(PLAIN, "p1"), chunk(b"v")],
    )
    .await
    .expect("the batch commits");

    assert_eq!(read(&engine, PLAIN, "p1").await, Some((1.0, b"v".to_vec())));
}

#[tokio::test]
async fn a_value_that_does_not_decode_is_refused_only_for_a_type_with_indexes() {
    let (_dir, engine) = documents_store().await;

    let error = commit(&engine, vec![put(NOTE, "n1"), chunk(&[0xFF])])
        .await
        .expect_err("not a Note");
    assert_eq!(error.code, "invalid_input");
    assert_eq!(read(&engine, NOTE, "n1").await, None);

    commit(&engine, vec![put(PLAIN, "p1"), chunk(&[0xFF])])
        .await
        .expect("a type without indexes is never decoded");
    assert_eq!(read(&engine, PLAIN, "p1").await, Some((1.0, vec![0xFF])));
}

#[tokio::test]
async fn changing_a_tag_moves_its_index_key() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("x");

    commit(&engine, put_value(NOTE, "n1", &note("T1", "y")))
        .await
        .expect("y");

    assert_eq!(
        value_of(&engine, prefixed("a", &by_tag("x", "n1"))).await,
        None
    );
    assert!(
        value_of(&engine, prefixed("a", &by_tag("y", "n1")))
            .await
            .is_some()
    );
    let header = header(&engine, NOTE, "n1").await.expect("a header");
    assert_eq!(
        sorted(header.index_keys),
        sorted(vec![by_tag("y", "n1"), by_title("T1")])
    );
}

#[tokio::test]
async fn a_value_over_one_record_continues_in_chunk_records() {
    let (_dir, engine) = documents_store().await;
    let value = bytes(CHUNK_BYTES + 1);

    commit(&engine, put_value(PLAIN, "p1", &value))
        .await
        .expect("the put commits");

    let header = header(&engine, PLAIN, "p1").await.expect("a header");
    assert_eq!(header.chunk_count, 1);
    assert_eq!(header.value_size as usize, value.len());
    assert_eq!(header.chunk, value[..CHUNK_BYTES]);
    let record = value_of(&engine, layout::chunk("a", PLAIN, "p1", 1)).await;
    assert_eq!(record, Some(value[CHUNK_BYTES..].to_vec()));
    assert_eq!(read(&engine, PLAIN, "p1").await, Some((1.0, value)));
}

#[tokio::test]
async fn a_smaller_put_removes_the_chunk_records() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(PLAIN, "p1", &bytes(CHUNK_BYTES + 1)))
        .await
        .expect("the large put commits");

    commit(&engine, put_value(PLAIN, "p1", b"small"))
        .await
        .expect("the small put commits");

    assert_eq!(
        header(&engine, PLAIN, "p1")
            .await
            .expect("a header")
            .chunk_count,
        0
    );
    let chunks = keys_in(&engine, under("a", &["doc.chunk", PLAIN, "p1"])).await;
    assert_eq!(chunks, Vec::<Vec<u8>>::new());
    assert_eq!(
        read(&engine, PLAIN, "p1").await,
        Some((2.0, b"small".to_vec()))
    );
}

#[tokio::test]
async fn a_16_mib_value_round_trips() {
    let (_dir, engine) = documents_store().await;
    let value = bytes(DOCUMENT_BYTES);

    commit(&engine, put_value(PLAIN, "p1", &value))
        .await
        .expect("the put commits");

    assert_eq!(read(&engine, PLAIN, "p1").await, Some((1.0, value)));
}

#[tokio::test]
async fn updated_at_is_an_iso_time_that_does_not_decrease() {
    let (_dir, engine) = documents_store().await;
    let clock = Clock::default();

    commit_with(&engine, &clock, vec![put(PLAIN, "p1")])
        .await
        .expect("the first put");
    let first = header(&engine, PLAIN, "p1")
        .await
        .expect("a header")
        .updated_at;
    commit_with(&engine, &clock, vec![put(PLAIN, "p1")])
        .await
        .expect("the second put");
    let second = header(&engine, PLAIN, "p1")
        .await
        .expect("a header")
        .updated_at;

    for written in [&first, &second] {
        assert_eq!(written.len(), "1970-01-01T00:00:00.000Z".len(), "{written}");
        assert_eq!(&written[10..11], "T");
        assert!(written.ends_with('Z'));
    }
    assert!(second >= first, "{second} < {first}");
}

#[tokio::test]
async fn every_key_a_commit_writes_is_under_the_prefix() {
    let (_dir, engine) = documents_store().await;
    let mut requests = put_value(NOTE, "n1", &note("T1", "x"));
    requests.extend(put_value(NOTE, "n2", &note("T2", "x")));
    requests.extend(put_value(PLAIN, "p1", &bytes(CHUNK_BYTES + 1)));
    commit(&engine, requests).await.expect("the puts commit");
    commit(&engine, vec![delete(NOTE, "n2")])
        .await
        .expect("the delete commits");

    let everything = KeyRange {
        start: Vec::new(),
        end: vec![0xFF; 8],
        keys_only: true,
        ..KeyRange::default()
    };
    let keys = keys_in(&engine, everything).await;
    assert!(!keys.is_empty());
    for key in keys {
        assert!(key.starts_with(b"a/"), "{key:?}");
    }
}

#[tokio::test]
async fn the_index_keys_follow_the_declaration_stored_when_the_batch_applies() {
    let (_dir, engine) = open_temp();
    register_documents(&engine, documents_set(NOTE_INDEXES)).await;
    let items = batch(put_value(NOTE, "n1", &note("T1", "x"))).expect("the batch is valid");
    let by_label = "indexes: { name: \"byLabel\" fields: \"tag\" }";
    register_documents(&engine, documents_set(by_label)).await;

    apply(
        &engine,
        &Clock::default(),
        &Pools::default(),
        &crate::cache::Headers::default(),
        &crate::watch::Watchers::default(),
        items,
    )
    .await
    .expect("the put commits");

    let label = index(NOTE, "byLabel", &[string("x")], Some("n1")).expect("an index key");
    let header = header(&engine, NOTE, "n1").await.expect("a header");
    assert_eq!(header.index_keys, vec![label.clone()]);
    assert!(value_of(&engine, prefixed("a", &label)).await.is_some());
    assert_eq!(
        value_of(&engine, prefixed("a", &by_tag("x", "n1"))).await,
        None
    );
}

#[tokio::test]
async fn a_non_unique_entry_is_empty_and_a_unique_entry_holds_the_id() {
    let (_dir, engine) = documents_store().await;

    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("the put commits");

    assert_eq!(
        value_of(&engine, prefixed("a", &by_tag("x", "n1"))).await,
        Some(Vec::new())
    );
    assert_eq!(
        value_of(&engine, prefixed("a", &by_title("T1"))).await,
        Some(b"n1".to_vec())
    );
}
