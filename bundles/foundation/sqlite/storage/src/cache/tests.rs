//! S77a4b: the header cache. Here its setting (H10, H11) and its header
//! (H12); in [`writes`], `Commit` and `Register` through one cache (H1, H2,
//! H5–H9, H13); in [`engines`], two engines on one file (H3, H4) and S78b's
//! blob writes after another engine's (R11); in [`suspension`], S77b1's
//! suspension of the cache (S1); in [`heads`], S78a's stream heads (R6–R8).

mod engines;
mod heads;
mod suspension;
mod writes;

use std::ops::ControlFlow;

use doric_sqlite::{KeyRange, KvEngine as _, SqliteEngine, limits};

use super::*;
use crate::{
    commit::{self, Batch, Clock},
    documents,
    keys::Element,
    layout,
    schema::Pools,
    testing::{NOTE, detail_str, note},
    v2::{
        CommitRequest, DocumentKey, ExpectedRevision, GetRequest, commit_request::Item,
        get_response,
    },
};

/// The bound of a cache that holds every header of these tests.
const ON: usize = 4096;
/// A cache on, then a cache off: the answers and the store are the same.
const BOUNDS: [usize; 2] = [ON, 0];

fn request(item: Item) -> CommitRequest {
    CommitRequest { item: Some(item) }
}

fn key(id: &str) -> DocumentKey {
    DocumentKey {
        r#type: NOTE.to_owned(),
        id: id.to_owned(),
    }
}

/// A put of the note `id` with `title` and `tag`.
fn put(id: &str, title: &str, tag: &str) -> Vec<CommitRequest> {
    vec![
        request(Item::Put(key(id))),
        request(Item::Chunk(note(title, tag))),
    ]
}

fn expect(id: &str, revision: f64) -> Vec<CommitRequest> {
    vec![request(Item::Expect(ExpectedRevision {
        r#type: NOTE.to_owned(),
        id: id.to_owned(),
        revision,
    }))]
}

fn delete(id: &str) -> Vec<CommitRequest> {
    vec![request(Item::Delete(key(id)))]
}

/// The items of `parts`, in order, committed as one batch of `a` through
/// `headers`.
async fn commit(
    engine: &SqliteEngine,
    headers: &Headers,
    parts: Vec<Vec<CommitRequest>>,
) -> Result<f64, ContractError> {
    let mut batch = Batch::new("a");
    for request in parts.into_iter().flatten() {
        batch.push(request).expect("the item is valid");
    }
    let items = batch.finish().expect("the batch is valid");
    commit::apply(
        engine,
        &Clock::default(),
        &Pools::default(),
        headers,
        &crate::watch::Watchers::default(),
        items,
    )
    .await
}

/// A `storage.kv/v1` commit of a `doric/` key on `engine`'s writer.
async fn kv_commit(engine: &SqliteEngine) {
    engine
        .commit(vec![limits::Item::Put {
            key: b"doric/k".to_vec(),
            value: b"v".to_vec(),
        }])
        .await
        .expect("the kv commit succeeds");
}

/// The revision `documents::get` answers for the note `id`, or `None`.
async fn revision(engine: &SqliteEngine, id: &str) -> Option<f64> {
    let request = GetRequest {
        r#type: NOTE.to_owned(),
        id: id.to_owned(),
    };
    engine
        .read(move |txn| {
            let mut revision = None;
            documents::get(txn, "a", &request, &mut |response| {
                if let Some(get_response::Item::Document(document)) = response.item {
                    revision = Some(document.revision);
                }
                ControlFlow::Continue(())
            })?;
            Ok(revision)
        })
        .await
        .expect("the get succeeds")
}

/// The keys of `range`, in key order.
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

fn string(text: &str) -> Element {
    Element::String(text.to_owned())
}

/// `byTag[value]`'s key of the note `id`, without the prefix.
fn by_tag(value: &str, id: &str) -> Vec<u8> {
    layout::index(NOTE, "byTag", &[string(value)], Some(id)).expect("an index key")
}

/// The unique `byTitle[title]`'s key, without the prefix.
fn by_title(title: &str) -> Vec<u8> {
    layout::index(NOTE, "byTitle", &[string(title)], None).expect("an index key")
}

/// The stored keys of `index`, prefixed, in key order.
async fn index_keys(engine: &SqliteEngine, index: &str) -> Vec<Vec<u8>> {
    keys_in(engine, layout::under("a", &["idx", NOTE, index])).await
}

/// `keys`, each under `a`'s prefix, in key order.
fn stored(keys: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut keys: Vec<_> = keys.iter().map(|key| layout::prefixed("a", key)).collect();
    keys.sort();
    keys
}

/// The entries a cache of `bound` holds when the transactions cached
/// `cached` headers that all fit: none when it is off.
fn cached(bound: usize, cached: usize) -> usize {
    if bound == 0 { 0 } else { cached }
}

#[test]
fn unset_empty_and_1_are_the_bundles_cache_and_0_is_off() {
    for value in [None, Some(""), Some("1")] {
        let headers = Headers::from_setting(value.map(OsStr::new)).expect("a valid setting");

        assert_eq!(headers.bound(), CACHE_BYTES, "for {value:?}");
        assert!(headers.is_empty(), "for {value:?}");
    }
    let off = Headers::from_setting(Some(OsStr::new("0"))).expect("a valid setting");

    assert_eq!(off.bound(), 0);
}

#[test]
fn any_other_setting_is_invalid_input_naming_the_variable() {
    for value in ["2", "true", " 1"] {
        let error =
            Headers::from_setting(Some(OsStr::new(value))).expect_err("the setting is refused");

        assert_eq!(error.code, "invalid_input", "for {value:?}");
        assert_eq!(
            detail_str(&error, "variable").as_deref(),
            Some(CACHE_VARIABLE),
            "for {value:?}"
        );
    }
    let error = Headers::from_setting(Some(OsStr::new("2"))).expect_err("2 is refused");

    assert_eq!(
        error.message,
        "DORIC_SQLITE_CACHE is \"0\" or \"1\"; \"2\" is not."
    );
}

#[cfg(unix)]
#[test]
fn a_setting_that_is_not_utf8_is_invalid_input_with_its_lossy_form() {
    use std::os::unix::ffi::OsStrExt as _;

    let error = Headers::from_setting(Some(OsStr::from_bytes(b"\xFF")))
        .expect_err("the setting is refused");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(
        detail_str(&error, "variable").as_deref(),
        Some("DORIC_SQLITE_CACHE")
    );
    assert_eq!(
        error.message,
        "DORIC_SQLITE_CACHE is \"0\" or \"1\"; \"\u{FFFD}\" is not."
    );
}

#[test]
fn a_header_keeps_every_field_of_the_stored_one_but_its_chunk() {
    let stored = layout::DocumentHeader {
        revision: 3,
        value_size: 1_000_000,
        chunk_count: 2,
        chunk: b"the first chunk".to_vec(),
        index_keys: vec![b"k1".to_vec(), b"k2".to_vec()],
        updated_at: "2026-11-28T12:00:00.000Z".to_owned(),
    };

    assert_eq!(
        Header::from(stored),
        Header {
            revision: 3,
            value_size: 1_000_000,
            chunk_count: 2,
            index_keys: vec![b"k1".to_vec(), b"k2".to_vec()],
            updated_at: "2026-11-28T12:00:00.000Z".to_owned(),
        }
    );
}
