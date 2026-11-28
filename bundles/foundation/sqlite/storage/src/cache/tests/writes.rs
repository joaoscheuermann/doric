//! S77a4b: `Commit` and `Register` of one engine through one cache: what the
//! cache holds after each, and that the answers and the store do not depend
//! on it (H1, H2, H5–H9, H13).

use super::*;
use crate::{
    query,
    register::{self, Registrations},
    testing::{NOTE_BY_TAG_ON_TITLE, caller, documents_set, documents_store},
    v2::{QueryRequest, StorageQuery},
};

#[tokio::test]
async fn a_rolled_back_put_is_not_cached() {
    for bound in BOUNDS {
        let (_dir, engine) = documents_store().await;
        let headers = Headers::new(bound);
        commit(
            &engine,
            &headers,
            vec![put("n0", "taken", "x"), put("n1", "t1", "x")],
        )
        .await
        .expect("n0 and n1");

        let error = commit(
            &engine,
            &headers,
            vec![put("n1", "t2", "x"), put("n2", "taken", "x")],
        )
        .await
        .expect_err("n0 holds the title taken");
        assert_eq!(error.code, "unique_conflict", "bound {bound}");
        assert_eq!(headers.len(), cached(bound, 2), "bound {bound}");

        let position = commit(
            &engine,
            &headers,
            vec![expect("n1", 1.0), put("n1", "t2", "x")],
        )
        .await;
        assert!(position.is_ok(), "bound {bound}: {position:?}");
        assert_eq!(revision(&engine, "n1").await, Some(2.0), "bound {bound}");
        assert_eq!(
            index_keys(&engine, "byTitle").await,
            stored(&[by_title("t2"), by_title("taken")]),
            "bound {bound}"
        );
    }
}

#[tokio::test]
async fn a_kv_commit_on_the_writer_keeps_the_cache() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");
    assert_eq!(headers.len(), 1);

    kv_commit(&engine).await;

    assert_eq!(headers.len(), 1);
    commit(
        &engine,
        &headers,
        vec![expect("n1", 1.0), put("n1", "t1", "y")],
    )
    .await
    .expect("n1 is at revision 1");
    assert_eq!(revision(&engine, "n1").await, Some(2.0));
}

#[tokio::test]
async fn a_full_cache_evicts_and_an_evicted_header_is_read_again() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    for batch in 0..10 {
        let puts = (0..20)
            .map(|n| {
                let i = batch * 20 + n;
                put(&format!("n{i:03}"), &format!("t{i:03}"), "x")
            })
            .collect();
        commit(&engine, &headers, puts).await.expect("20 notes");
    }

    assert!(headers.bytes() <= ON, "{} bytes", headers.bytes());
    assert!(headers.len() < 200, "{} entries", headers.len());
    commit(
        &engine,
        &headers,
        vec![expect("n000", 1.0), put("n000", "t000", "y")],
    )
    .await
    .expect("n000 is at revision 1");
    assert_eq!(revision(&engine, "n000").await, Some(2.0));
}

#[tokio::test]
async fn an_entry_counts_its_key_its_index_keys_and_entry_bytes() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);

    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");

    let expected = layout::document("a", NOTE, "n1").len()
        + by_tag("x", "n1").len()
        + by_title("t1").len()
        + ENTRY_BYTES;
    assert_eq!(headers.len(), 1);
    assert_eq!(headers.bytes(), expected);
}

#[tokio::test]
async fn a_bound_of_0_caches_nothing() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(0);

    for (id, title) in [("n1", "t1"), ("n2", "t2"), ("n3", "t3")] {
        commit(&engine, &headers, vec![put(id, title, "x")])
            .await
            .expect("a put");
    }
    commit(&engine, &headers, vec![put("n1", "t9", "y")])
        .await
        .expect("a second put of n1");

    assert_eq!(headers.len(), 0);
    assert_eq!(headers.bytes(), 0);
    assert_eq!(revision(&engine, "n1").await, Some(2.0));
}

#[tokio::test]
async fn a_deleted_document_leaves_the_cache_and_restarts_at_1() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");

    commit(&engine, &headers, vec![delete("n1")])
        .await
        .expect("the delete");

    assert_eq!(headers.len(), 0);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1 again");
    assert_eq!(revision(&engine, "n1").await, Some(1.0));
}

#[tokio::test]
async fn a_rebuild_drops_the_headers_it_rewrote() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(
        &engine,
        &headers,
        vec![put("n1", "t1", "x"), put("n2", "t2", "x")],
    )
    .await
    .expect("n1 and n2");
    assert_eq!(headers.len(), 2);
    let registration = register::prepare(&caller("a", 1), documents_set(NOTE_BY_TAG_ON_TITLE))
        .expect("the set is valid");

    Registrations::default()
        .apply(&engine, &headers, registration)
        .await
        .expect("byTag is rebuilt on title");

    assert_eq!(headers.len(), 0);
    commit(&engine, &headers, vec![put("n1", "t9", "x")])
        .await
        .expect("n1 with a new title");
    assert_eq!(
        index_keys(&engine, "byTag").await,
        stored(&[by_tag("t9", "n1"), by_tag("t2", "n2")])
    );
    assert_eq!(revision(&engine, "n1").await, Some(2.0));
}

#[tokio::test]
async fn a_get_and_a_query_leave_the_cache_as_it_was() {
    let (_dir, engine) = documents_store().await;
    let headers = Headers::new(ON);
    commit(&engine, &headers, vec![put("n1", "t1", "x")])
        .await
        .expect("n1");
    let (len, bytes) = (headers.len(), headers.bytes());

    assert_eq!(revision(&engine, "n1").await, Some(1.0));
    let plan = query::check(
        "a",
        &QueryRequest {
            storage_query: Some(StorageQuery {
                r#type: NOTE.to_owned(),
                index: "byTag".to_owned(),
                limit: 10,
                ..StorageQuery::default()
            }),
        },
    )
    .expect("the query is valid");
    let found = engine
        .read(move |txn| {
            let mut found = 0;
            query::page(txn, "a", &plan, &mut |_| {
                found += 1;
                ControlFlow::Continue(())
            })?;
            Ok(found)
        })
        .await
        .expect("the query succeeds");

    assert!(found > 0, "the query found n1");
    assert_eq!((headers.len(), headers.bytes()), (len, bytes));
}
