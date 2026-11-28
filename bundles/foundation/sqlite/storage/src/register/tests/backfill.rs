//! S77a4a: `Register` rebuilds the indexes it changes on a type with
//! documents, in the write transaction that rewrites the declaration (A81,
//! RK27; B1–B11).

use std::{ops::ControlFlow, sync::mpsc, time::Duration};

use doric_sqlite::{KeyRange, KvEngine, ReadTxn, SqliteEngine};
use prost::Message as _;
use prost_types::value::Kind;

use super::{current, declaration, entries, fresh, probe, schema as stored_set, sha256hex, value};
use crate::{
    commit::{self, Batch, Clock, PART_BYTES},
    keys::Element,
    layout::{self, DocumentHeader, IndexDeclaration, index, prefixed, under},
    register::{REBUILD_DOCUMENTS, Rebuilt, Registrations, prepare},
    schema::Pools,
    testing::{
        NOTE, NOTE_BY_TAG, NOTE_BY_TAG_ON_TITLE, NOTE_BY_TITLE, NOTE_INDEXES, NOTE_REORDERED,
        caller, detail_str, documents_set, documents_set_with_title, note,
    },
    v2::{CommitRequest, DocumentKey, commit_request::Item},
};
use doric_bundle::ContractError;

/// `prepare`, then `apply`, for the bundle `a` at `generation`.
async fn register(
    registrations: &Registrations,
    engine: &SqliteEngine,
    generation: u32,
    set: &[u8],
) -> Result<Vec<Rebuilt>, ContractError> {
    let registration = prepare(&caller("a", generation), set.to_vec())?;
    registrations.apply(engine, registration).await
}

fn key(id: &str) -> DocumentKey {
    DocumentKey {
        r#type: NOTE.to_owned(),
        id: id.to_owned(),
    }
}

/// One commit of `a`: a put of each `(id, value)` of `puts`, then a delete of
/// each id of `deletes`.
async fn commit(engine: &SqliteEngine, puts: &[(String, Vec<u8>)], deletes: &[&str]) {
    let mut batch = Batch::new("a");
    for (id, value) in puts {
        let put = Item::Put(key(id));
        batch
            .push(CommitRequest { item: Some(put) })
            .expect("a put");
        for part in value.chunks(PART_BYTES) {
            let chunk = Item::Chunk(part.to_vec());
            batch
                .push(CommitRequest { item: Some(chunk) })
                .expect("a chunk");
        }
    }
    for id in deletes {
        let delete = Item::Delete(key(id));
        batch
            .push(CommitRequest { item: Some(delete) })
            .expect("a delete");
    }
    let items = batch.finish().expect("the batch is valid");
    commit::apply(
        engine,
        &Clock::default(),
        &Pools::default(),
        &crate::watch::Watchers::default(),
        items,
    )
    .await
    .expect("the batch commits");
}

/// `count` notes `n0000`, `n0001`, … titled `t0000`, `t0001`, … with the tag
/// `x`, in id order.
fn notes(count: usize) -> Vec<(String, Vec<u8>)> {
    (0..count)
        .map(|n| (format!("n{n:04}"), note(&format!("t{n:04}"), "x")))
        .collect()
}

fn one(id: &str, title: &str, tag: &str) -> (String, Vec<u8>) {
    (id.to_owned(), note(title, tag))
}

fn string(text: &str) -> Element {
    Element::String(text.to_owned())
}

fn by_tag(tag: &str, id: &str) -> Vec<u8> {
    index(NOTE, "byTag", &[string(tag)], Some(id)).expect("an index key")
}

fn by_title(title: &str) -> Vec<u8> {
    index(NOTE, "byTitle", &[string(title)], None).expect("an index key")
}

/// The store's keys of `NOTE`'s index `name`.
fn index_range(name: &str) -> KeyRange {
    under("a", &["idx", NOTE, name])
}

/// The keys and values of `range`.
async fn pairs(engine: &SqliteEngine, range: KeyRange) -> Vec<(Vec<u8>, Vec<u8>)> {
    let found = entries(engine, range).await.into_iter();
    found.map(|(key, value, _)| (key, value)).collect()
}

/// The keys of `range`.
async fn keys_of(engine: &SqliteEngine, range: KeyRange) -> Vec<Vec<u8>> {
    let found = entries(engine, range).await.into_iter();
    found.map(|(key, _, _)| key).collect()
}

/// Every stored header of `NOTE`, in id key order.
async fn headers(engine: &SqliteEngine) -> Vec<DocumentHeader> {
    let found = entries(engine, under("a", &["doc", NOTE]))
        .await
        .into_iter();
    found
        .map(|(_, bytes, _)| DocumentHeader::decode(bytes.as_slice()).expect("a header"))
        .collect()
}

async fn header(engine: &SqliteEngine, id: &str) -> DocumentHeader {
    let bytes = value(engine, layout::document("a", NOTE, id)).await;
    DocumentHeader::decode(bytes.expect("a header").as_slice()).expect("a header")
}

/// The string list detail `field` of `error`.
fn detail_strings(error: &ContractError, field: &str) -> Option<Vec<String>> {
    match error.details.as_ref()?.fields.get(field)?.kind.as_ref()? {
        Kind::ListValue(list) => list
            .values
            .iter()
            .map(|value| match value.kind.as_ref()? {
                Kind::StringValue(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// The number of keys of `range` that `txn` sees.
fn count(txn: &mut dyn ReadTxn, range: &KeyRange) -> Result<usize, ContractError> {
    let mut found = 0;
    txn.range(range, &mut |_| {
        found += 1;
        ControlFlow::Continue(())
    })?;
    Ok(found)
}

/// `count` headers of `NOTE` (`d000000`, …) encoding a default
/// `DocumentHeader`, planted in one write.
async fn plant_headers(engine: &SqliteEngine, count: usize) {
    let header = DocumentHeader::default().encode_to_vec();
    engine
        .write(move |txn| {
            for n in 0..count {
                txn.put(&layout::document("a", NOTE, &format!("d{n:06}")), &header)?;
            }
            Ok(())
        })
        .await
        .expect("the headers are planted");
}

#[tokio::test]
async fn adding_an_index_rebuilds_its_keys_and_every_header() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("byTag registers");
    let notes = notes(1000);
    commit(&engine, &notes, &[]).await;
    let before = headers(&engine).await;
    let set = documents_set(NOTE_INDEXES);

    let rebuilt = register(&registrations, &engine, 1, &set)
        .await
        .expect("the new index is rebuilt");

    assert_eq!(rebuilt.len(), 1);
    assert_eq!(rebuilt[0].type_id, NOTE);
    assert_eq!(rebuilt[0].documents, 1000);
    let mut expected: Vec<_> = (0..1000)
        .map(|n| {
            let key = prefixed("a", &by_title(&format!("t{n:04}")));
            (key, format!("n{n:04}").into_bytes())
        })
        .collect();
    expected.sort();
    assert_eq!(pairs(&engine, index_range("byTitle")).await, expected);
    let after = headers(&engine).await;
    assert_eq!(after.len(), 1000);
    for (n, (old, new)) in before.iter().zip(&after).enumerate() {
        let (id, title) = (format!("n{n:04}"), format!("t{n:04}"));
        assert_eq!(new.index_keys, vec![by_tag("x", &id), by_title(&title)]);
        assert_eq!(new.revision, old.revision);
        assert_eq!(new.updated_at, old.updated_at);
    }
    let stored = declaration(&engine, "a", NOTE)
        .await
        .expect("a declaration");
    assert_eq!(stored.schema, sha256hex(&set));
}

#[tokio::test]
async fn a_reader_sees_the_rebuild_whole_or_not_at_all() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("byTag registers");
    commit(&engine, &notes(1000), &[]).await;
    let (counted, first_count) = tokio::sync::oneshot::channel();
    let (go, wait) = mpsc::channel::<()>();
    let range = index_range("byTitle");

    let read = engine.read(move |txn| {
        let first = count(txn, &range)?;
        let _ = counted.send(first);
        let _ = wait.recv();
        Ok((first, count(txn, &range)?))
    });
    let rebuild = async {
        let _ = first_count.await;
        let registered = register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES)).await;
        let _ = go.send(());
        registered
    };
    let (snapshot, registered) = tokio::join!(read, rebuild);

    registered.expect("the new index is rebuilt");
    assert_eq!(snapshot.expect("the read succeeds"), (0, 0));
    let range = index_range("byTitle");
    let later = engine.read(move |txn| count(txn, &range)).await;
    assert_eq!(later.expect("the read succeeds"), 1000);
}

#[tokio::test]
async fn two_documents_sharing_a_new_unique_key_refuse_the_rebuild_and_write_nothing() {
    let (_dir, engine, registrations) = fresh();
    let (old, new) = (documents_set(NOTE_BY_TAG), documents_set(NOTE_INDEXES));
    register(&registrations, &engine, 1, &old)
        .await
        .expect("byTag registers");
    let notes = [one("n1", "same", "a"), one("n2", "same", "b")];
    commit(&engine, &notes, &[]).await;
    let stored = declaration(&engine, "a", NOTE).await;

    let error = register(&registrations, &engine, 1, &new)
        .await
        .expect_err("the shared title is refused");

    assert_eq!(error.code, "unique_conflict");
    assert_eq!(detail_str(&error, "type").as_deref(), Some(NOTE));
    assert_eq!(detail_str(&error, "index").as_deref(), Some("byTitle"));
    let ids = vec!["n1".to_owned(), "n2".to_owned()];
    assert_eq!(detail_strings(&error, "ids"), Some(ids));
    assert_eq!(declaration(&engine, "a", NOTE).await, stored);
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&old)));
    assert_eq!(stored_set(&engine, "a", &old).await, Some(old.clone()));
    assert_eq!(stored_set(&engine, "a", &new).await, None);
    assert_eq!(
        keys_of(&engine, index_range("byTitle")).await,
        Vec::<Vec<u8>>::new()
    );

    let again = register(&registrations, &engine, 1, &old).await;
    assert_eq!(again.expect("the old set registers"), Vec::new());
    commit(&engine, &[], &["n2"]).await;
    let rebuilt = register(&registrations, &engine, 1, &new)
        .await
        .expect("without the conflict the new set registers");
    assert_eq!(rebuilt.len(), 1);
    assert_eq!(rebuilt[0].documents, 1);
}

#[tokio::test]
async fn a_changed_index_takes_its_new_fields_and_leaves_the_other_index_alone() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES))
        .await
        .expect("the fixture registers");
    let notes = [one("n1", "T1", "x"), one("n2", "T2", "y")];
    commit(&engine, &notes, &[]).await;
    let titles = entries(&engine, index_range("byTitle")).await;

    register(
        &registrations,
        &engine,
        1,
        &documents_set(NOTE_BY_TAG_ON_TITLE),
    )
    .await
    .expect("byTag on title is rebuilt");

    let tags = keys_of(&engine, index_range("byTag")).await;
    let expected = vec![
        prefixed("a", &by_tag("T1", "n1")),
        prefixed("a", &by_tag("T2", "n2")),
    ];
    assert_eq!(tags, expected);
    for old in [by_tag("x", "n1"), by_tag("y", "n2")] {
        assert!(!tags.contains(&prefixed("a", &old)));
    }
    assert_eq!(entries(&engine, index_range("byTitle")).await, titles);
    for (id, title) in [("n1", "T1"), ("n2", "T2")] {
        let keys = header(&engine, id).await.index_keys;
        assert_eq!(keys, vec![by_tag(title, id), by_title(title)]);
    }
}

#[tokio::test]
async fn removing_an_index_deletes_its_keys_and_counts_the_documents() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES))
        .await
        .expect("the fixture registers");
    let notes = [
        one("n1", "T1", "x"),
        one("n2", "T2", "y"),
        one("n3", "T3", "x"),
    ];
    commit(&engine, &notes, &[]).await;

    let rebuilt = register(&registrations, &engine, 1, &documents_set(NOTE_BY_TITLE))
        .await
        .expect("byTag is removed");

    assert_eq!(rebuilt.len(), 1);
    assert_eq!(rebuilt[0].documents, 3);
    assert_eq!(
        keys_of(&engine, index_range("byTag")).await,
        Vec::<Vec<u8>>::new()
    );
    for (id, title) in [("n1", "T1"), ("n2", "T2"), ("n3", "T3")] {
        assert_eq!(header(&engine, id).await.index_keys, vec![by_title(title)]);
    }
}

#[tokio::test]
async fn one_document_over_the_rebuild_limit_is_refused_before_any_decode() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("byTag registers");
    plant_headers(&engine, 100_001).await;
    let stored = declaration(&engine, "a", NOTE).await;

    let error = register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES))
        .await
        .expect_err("100,001 documents are refused");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(detail_str(&error, "limit").as_deref(), Some("rebuild"));
    assert_eq!(declaration(&engine, "a", NOTE).await, stored);
}

#[tokio::test]
async fn exactly_the_rebuild_limit_of_documents_rebuilds() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES))
        .await
        .expect("the fixture registers");
    plant_headers(&engine, 100_000).await;

    let rebuilt = register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("100,000 documents rebuild");

    assert_eq!(REBUILD_DOCUMENTS, 100_000);
    assert_eq!(rebuilt.len(), 1);
    assert_eq!(rebuilt[0].documents, 100_000);
}

#[tokio::test]
async fn a_lower_generation_after_a_rebuild_changes_nothing() {
    let (_dir, engine, registrations) = fresh();
    let (first, second) = (documents_set(NOTE_BY_TAG), documents_set(NOTE_INDEXES));
    register(&registrations, &engine, 1, &first)
        .await
        .expect("generation 1 registers");
    commit(&engine, &[one("n1", "T1", "x")], &[]).await;
    register(&registrations, &engine, 2, &second)
        .await
        .expect("generation 2 rebuilds");
    commit(&engine, &[one("n9", "T9", "z")], &[]).await;
    let stored = declaration(&engine, "a", NOTE).await;

    let before = probe(&engine).await;
    let again = register(&registrations, &engine, 1, &first).await;
    let after = probe(&engine).await;

    assert_eq!(again.expect("generation 1 answers Ok"), Vec::new());
    assert_eq!(after, before + 1.0);
    let keys = header(&engine, "n9").await.index_keys;
    assert_eq!(keys, vec![by_tag("z", "n9"), by_title("T9")]);
    assert_eq!(declaration(&engine, "a", NOTE).await, stored);
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&second)));
}

#[tokio::test]
async fn a_stored_value_the_new_message_does_not_decode_is_refused() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("byTag registers");
    commit(&engine, &[one("n1", "T1", "x")], &[]).await;
    let stored = declaration(&engine, "a", NOTE).await;
    let int_title = documents_set_with_title(NOTE_INDEXES, "int32");

    let error = register(&registrations, &engine, 1, &int_title)
        .await
        .expect_err("a string title is no int32");

    assert_eq!(error.code, "invalid_input");
    assert!(
        error
            .message
            .starts_with("The value does not decode as fixture.v1.Note: "),
        "{}",
        error.message
    );
    assert_eq!(declaration(&engine, "a", NOTE).await, stored);
}

#[tokio::test]
async fn a_reordered_index_list_rewrites_only_the_declaration() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(NOTE_INDEXES))
        .await
        .expect("the fixture registers");
    let notes = [one("n1", "T1", "x"), one("n2", "T2", "y")];
    commit(&engine, &notes, &[]).await;
    let indexed = entries(&engine, under("a", &["idx", NOTE])).await;
    let reordered = documents_set(NOTE_REORDERED);

    let rebuilt = register(&registrations, &engine, 1, &reordered).await;

    assert_eq!(rebuilt.expect("the reorder registers"), Vec::new());
    let stored = declaration(&engine, "a", NOTE)
        .await
        .expect("a declaration");
    let index_of = |name: &str, field: &str, unique| IndexDeclaration {
        name: name.to_owned(),
        fields: vec![field.to_owned()],
        unique,
    };
    let expected = vec![
        index_of("byTitle", "title", true),
        index_of("byTag", "tag", false),
    ];
    assert_eq!(stored.indexes, expected);
    assert_eq!(stored.schema, sha256hex(&reordered));
    assert_eq!(entries(&engine, under("a", &["idx", NOTE])).await, indexed);
}

#[tokio::test]
async fn a_value_stored_in_chunks_is_decoded_whole() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, 1, &documents_set(""))
        .await
        .expect("NOTE without indexes registers");
    let title = "t".repeat(1_000_000);
    commit(&engine, &[one("n1", &title, "x")], &[]).await;
    assert!(header(&engine, "n1").await.chunk_count >= 1);

    register(&registrations, &engine, 1, &documents_set(NOTE_BY_TAG))
        .await
        .expect("byTag is rebuilt");

    let tags = keys_of(&engine, index_range("byTag")).await;
    assert_eq!(tags, vec![prefixed("a", &by_tag("x", "n1"))]);
}

#[test]
fn a_rebuild_logs_its_type_documents_and_whole_milliseconds() {
    let rebuilt = Rebuilt {
        type_id: "a.note/v1".to_owned(),
        documents: 3,
        elapsed: Duration::from_micros(1999),
    };

    assert_eq!(
        rebuilt.to_string(),
        "Rebuilt the indexes of a.note/v1: 3 documents in 1 ms."
    );
}
