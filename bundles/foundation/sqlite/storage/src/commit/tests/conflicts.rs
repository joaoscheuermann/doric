//! S77a3a: a batch refused by the store's state, writing nothing: expects,
//! undeclared types, unique keys and concurrent commits (C16–C18, C20, C21,
//! C26).

use super::*;
use crate::testing::{PLAIN, detail_num, documents_store, note};

const OTHER: &str = "a.other/v1";

/// The details `type` and `index` of a `unique_conflict`.
fn assert_unique_conflict(error: &ContractError) {
    assert_eq!(error.code, "unique_conflict");
    assert_eq!(detail_str(error, "type").as_deref(), Some(NOTE));
    assert_eq!(detail_str(error, "index").as_deref(), Some("byTitle"));
}

#[tokio::test]
async fn a_mismatched_expect_is_a_revision_conflict_and_writes_nothing() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, vec![put(PLAIN, "p1"), chunk(b"v")])
        .await
        .expect("revision 1");
    let before = probe(&engine).await;

    let error = commit(
        &engine,
        vec![expect(PLAIN, "p1", 2.0), put(PLAIN, "p2"), chunk(b"w")],
    )
    .await
    .expect_err("p1 is at revision 1");

    assert_eq!(error.code, "revision_conflict");
    assert_eq!(detail_str(&error, "type").as_deref(), Some(PLAIN));
    assert_eq!(detail_str(&error, "id").as_deref(), Some("p1"));
    assert_eq!(detail_num(&error, "expected"), Some(2.0));
    assert_eq!(detail_num(&error, "actual"), Some(1.0));
    assert_eq!(read(&engine, PLAIN, "p2").await, None);
    assert_eq!(probe(&engine).await, before + 1.0);
}

#[tokio::test]
async fn an_expect_of_0_holds_only_while_the_document_is_absent() {
    let (_dir, engine) = documents_store().await;

    commit(&engine, vec![expect(PLAIN, "p1", 0.0), put(PLAIN, "p1")])
        .await
        .expect("p1 is absent");
    let error = commit(&engine, vec![expect(PLAIN, "p1", 0.0), put(PLAIN, "p1")])
        .await
        .expect_err("p1 is present");

    assert_eq!(error.code, "revision_conflict");
    assert_eq!(detail_num(&error, "expected"), Some(0.0));
    assert_eq!(detail_num(&error, "actual"), Some(1.0));
}

#[tokio::test]
async fn one_stale_expect_among_several_leaves_every_document_unchanged() {
    let (_dir, engine) = documents_store().await;
    commit(
        &engine,
        vec![
            put(PLAIN, "p1"),
            chunk(b"one"),
            put(PLAIN, "p2"),
            chunk(b"two"),
        ],
    )
    .await
    .expect("p1 and p2");

    let error = commit(
        &engine,
        vec![
            expect(PLAIN, "p1", 1.0),
            expect(PLAIN, "p2", 5.0),
            put(PLAIN, "p1"),
            chunk(b"new"),
            delete(PLAIN, "p2"),
            put(PLAIN, "p3"),
        ],
    )
    .await
    .expect_err("p2's expect is stale");

    assert_eq!(error.code, "revision_conflict");
    assert_eq!(
        read(&engine, PLAIN, "p1").await,
        Some((1.0, b"one".to_vec()))
    );
    assert_eq!(
        read(&engine, PLAIN, "p2").await,
        Some((1.0, b"two".to_vec()))
    );
    assert_eq!(read(&engine, PLAIN, "p3").await, None);
}

#[tokio::test]
async fn an_undeclared_type_is_unknown_type_in_each_item_and_writes_nothing() {
    let (_dir, engine) = documents_store().await;
    for item in [
        put(OTHER, "o1"),
        expect(OTHER, "o1", 0.0),
        delete(OTHER, "o1"),
    ] {
        let before = probe(&engine).await;

        let error = commit(&engine, vec![put(PLAIN, "p1"), chunk(b"v"), item])
            .await
            .expect_err("a.other/v1 is not declared");

        assert_eq!(error.code, "unknown_type");
        assert_eq!(detail_str(&error, "type").as_deref(), Some(OTHER));
        assert_eq!(read(&engine, PLAIN, "p1").await, None);
        assert_eq!(probe(&engine).await, before + 1.0);
    }
}

#[tokio::test]
async fn a_put_of_a_taken_unique_key_is_a_unique_conflict_and_writes_nothing() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("n1 takes T1");

    let mut requests = put_value(NOTE, "n2", &note("T2", "x"));
    requests.extend(put_value(NOTE, "n3", &note("T1", "x")));
    let error = commit(&engine, requests).await.expect_err("T1 is taken");

    assert_unique_conflict(&error);
    assert_eq!(read(&engine, NOTE, "n2").await, None);
    assert_eq!(read(&engine, NOTE, "n3").await, None);
}

#[tokio::test]
async fn a_unique_key_is_free_only_after_the_earlier_put_that_moves_it_away() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("n1 takes T1");

    let mut takes_first = put_value(NOTE, "n2", &note("T1", "x"));
    takes_first.extend(put_value(NOTE, "n1", &note("T9", "x")));
    let error = commit(&engine, takes_first)
        .await
        .expect_err("n1 still holds T1");
    assert_unique_conflict(&error);

    let mut moves_first = put_value(NOTE, "n1", &note("T9", "x"));
    moves_first.extend(put_value(NOTE, "n2", &note("T1", "x")));
    commit(&engine, moves_first)
        .await
        .expect("n1 frees T1 first");
    assert_eq!(
        read(&engine, NOTE, "n2")
            .await
            .map(|(revision, _)| revision),
        Some(1.0)
    );
    assert_eq!(
        read(&engine, NOTE, "n1")
            .await
            .map(|(revision, _)| revision),
        Some(2.0)
    );
}

#[tokio::test]
async fn a_put_that_keeps_its_own_unique_key_succeeds() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("n1 takes T1");

    commit(&engine, put_value(NOTE, "n1", &note("T1", "y")))
        .await
        .expect("n1 keeps T1");

    assert_eq!(
        read(&engine, NOTE, "n1")
            .await
            .map(|(revision, _)| revision),
        Some(2.0)
    );
}

#[tokio::test]
async fn a_delete_frees_its_unique_key_for_a_put_of_the_same_batch() {
    let (_dir, engine) = documents_store().await;
    commit(&engine, put_value(NOTE, "n1", &note("T1", "x")))
        .await
        .expect("n1 takes T1");

    let mut requests = vec![delete(NOTE, "n1")];
    requests.extend(put_value(NOTE, "n2", &note("T1", "x")));
    commit(&engine, requests)
        .await
        .expect("the delete frees T1");

    assert_eq!(read(&engine, NOTE, "n1").await, None);
    assert_eq!(
        read(&engine, NOTE, "n2")
            .await
            .map(|(revision, _)| revision),
        Some(1.0)
    );
}

#[tokio::test]
async fn two_concurrent_creates_of_one_id_give_one_revision_conflict() {
    let (_dir, engine) = documents_store().await;
    let create = |value: &'static [u8]| {
        commit(
            &engine,
            vec![expect(PLAIN, "p1", 0.0), put(PLAIN, "p1"), chunk(value)],
        )
    };

    let (first, second) = tokio::join!(create(b"one"), create(b"two"));

    let codes: Vec<_> = [first, second]
        .into_iter()
        .map(|result| result.err().map(|error| error.code))
        .collect();
    assert!(codes.contains(&None), "{codes:?}");
    assert!(
        codes.contains(&Some("revision_conflict".to_owned())),
        "{codes:?}"
    );
}

#[tokio::test]
async fn two_concurrent_puts_of_one_unique_key_give_one_unique_conflict() {
    let (_dir, engine) = documents_store().await;
    let take = |id: &'static str| commit(&engine, put_value(NOTE, id, &note("T1", "x")));

    let (first, second) = tokio::join!(take("n1"), take("n2"));

    let codes: Vec<_> = [first, second]
        .into_iter()
        .map(|result| result.err().map(|error| error.code))
        .collect();
    assert!(codes.contains(&None), "{codes:?}");
    assert!(
        codes.contains(&Some("unique_conflict".to_owned())),
        "{codes:?}"
    );
}
