//! S77b1: a [`Suspension`] of the cache ([`Headers::suspend`]), which a
//! `storage.kv/v1` commit outside `doric/` holds (S1): while it is alive,
//! every [`Headers::begin`] starts on an empty cache; dropping it clears what
//! was cached during it; once it is dropped, the cache is used again.

use super::*;
use crate::testing::documents_store;

/// The entries `headers` holds right after a [`Headers::begin`] on a write
/// transaction of `engine` in which no other connection wrote.
async fn entries_after_begin(engine: &SqliteEngine, headers: &Headers) -> usize {
    let headers = headers.clone();
    let (entries, _) = engine
        .write(move |txn| {
            let staged = headers.begin(txn);
            let entries = headers.len();
            drop(staged);
            Ok(entries)
        })
        .await
        .expect("the write succeeds");
    entries
}

#[tokio::test]
async fn while_suspended_begin_starts_on_an_empty_cache() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");
    assert_eq!(headers.len(), 1);

    let suspension = headers.suspend();

    assert_eq!(entries_after_begin(&engine, &headers).await, 0);
    drop(suspension);
}

#[tokio::test]
async fn an_entry_cached_while_suspended_is_gone_once_the_suspension_is_dropped() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");
    let suspension = headers.suspend();

    commit(&engine, &headers, vec![put("n2", "t2", "x")])
        .await
        .expect("n2");
    drop(suspension);

    assert!(headers.is_empty(), "{} entries", headers.len());
}

#[tokio::test]
async fn once_the_suspension_is_dropped_begin_keeps_new_entries() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");
    drop(headers.suspend());

    commit(&engine, &headers, vec![put("n2", "t2", "x")])
        .await
        .expect("n2");

    assert_eq!(entries_after_begin(&engine, &headers).await, 1);
    commit(&engine, &headers, vec![put("n3", "t3", "x")])
        .await
        .expect("n3");
    assert_eq!(headers.len(), 2);
}
