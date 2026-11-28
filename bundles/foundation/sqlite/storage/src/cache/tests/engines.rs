//! S77a4b: two engines on one file, each with its own cache: a write of the
//! other engine is never hidden by a cached header, with or without a
//! `storage.kv/v1` commit in between (H3, H4).

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
