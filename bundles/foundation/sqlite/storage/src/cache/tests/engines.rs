//! S77a4b: two engines on one file, each with its own cache: a write of the
//! other engine is never hidden by a cached header, with or without a
//! `storage.kv/v1` commit in between (H3, H4); S78b: a blob write after a
//! write of the other engine clears the cache (R11).

use super::*;
use crate::testing::{NOTE_INDEXES, TempDir, documents_set, register_documents};

/// A puts n1, B puts n1, then, after a `storage.kv/v1` commit on A when `kv`,
/// A puts n1: each put takes the revision the other engine's left plus 1, and
/// A's cache holds n1.
async fn alternate_puts(bound: usize, kv: bool) {
    let dir = TempDir::new();
    let a = doric_sqlite::open(dir.path()).expect("open A");
    let b = doric_sqlite::open(dir.path()).expect("open B");
    register_documents(&a, documents_set(NOTE_INDEXES)).await;
    let (on_a, on_b) = (Headers::new(bound), Headers::new(bound));

    commit(&a, &on_a, vec![put("n1", "t1", "x")])
        .await
        .expect("A puts n1");
    commit(&b, &on_b, vec![put("n1", "t1", "y")])
        .await
        .expect("B puts n1");
    if kv {
        kv_commit(&a).await;
    }
    commit(&a, &on_a, vec![put("n1", "t1", "z")])
        .await
        .expect("A puts n1 again");

    assert_eq!(revision(&a, "n1").await, Some(3.0), "bound {bound}");
    assert_eq!(on_a.len(), cached(bound, 1), "bound {bound}");
    let expected = commit(&a, &on_a, vec![expect("n1", 3.0), put("n1", "t1", "w")]).await;
    assert!(expected.is_ok(), "bound {bound}: {expected:?}");
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn a_put_of_another_engine_is_read_after_it() {
    for bound in BOUNDS {
        alternate_puts(bound, false).await;
    }
}

#[tokio::test]
async fn a_put_of_another_engine_is_read_after_a_kv_commit_of_this_one() {
    for bound in BOUNDS {
        alternate_puts(bound, true).await;
    }
}

// S78b: a blob write is a write of this library and calls `Headers::begin`
// first (R11).

/// A puts n1, B puts n1, then `blob_write` runs on A through A's cache, with
/// B at hand: the write clears A's cache, which held n1 at revision 1, so
/// A's next commit reads B's revision 2 from SQLite.
async fn blob_write_after_a_foreign_put(
    blob_write: impl AsyncFnOnce(&SqliteEngine, &Headers, &SqliteEngine),
) {
    let dir = TempDir::new();
    let a = doric_sqlite::open(dir.path()).expect("open A");
    let b = doric_sqlite::open(dir.path()).expect("open B");
    register_documents(&a, documents_set(NOTE_INDEXES)).await;
    let (on_a, on_b) = (Headers::new(ON), Headers::new(ON));
    commit(&a, &on_a, vec![put("n1", "t1", "x")])
        .await
        .expect("A puts n1");
    assert_eq!(on_a.len(), 1);
    commit(&b, &on_b, vec![put("n1", "t1", "y")])
        .await
        .expect("B puts n1");

    blob_write(&a, &on_a, &b).await;

    assert!(on_a.is_empty(), "the blob write cleared A's cache");
    let expected = commit(&a, &on_a, vec![expect("n1", 2.0), put("n1", "t1", "z")]).await;
    assert!(expected.is_ok(), "{expected:?}");
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn a_blob_put_after_a_put_of_another_engine_clears_the_cache() {
    blob_write_after_a_foreign_put(async |engine, headers, _| {
        let mut upload = crate::blobs::Upload::new();
        upload.push(b"blob".to_vec()).expect("the part fits");
        crate::blobs::put(engine, headers, "a", upload)
            .await
            .expect("the blob put succeeds");
    })
    .await;
}

#[tokio::test]
async fn a_blob_delete_after_a_put_of_another_engine_clears_the_cache() {
    blob_write_after_a_foreign_put(async |engine, headers, other| {
        let mut upload = crate::blobs::Upload::new();
        upload.push(b"blob".to_vec()).expect("the part fits");
        let hash = crate::blobs::put(other, &Headers::new(ON), "a", upload)
            .await
            .expect("B puts the blob");
        crate::blobs::delete(engine, headers, "a", &hash)
            .await
            .expect("the blob delete succeeds");
    })
    .await;
}
