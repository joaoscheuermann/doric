use super::*;
use crate::{
    limits::Item,
    store::{SqliteEngine, testing::*},
};

fn put(key: &[u8], value: &[u8]) -> Item {
    Item::Put {
        key: key.to_vec(),
        value: value.to_vec(),
    }
}

fn entry(key: &[u8], value: &[u8], version: f64) -> RangeResponse {
    RangeResponse {
        key: key.to_vec(),
        value: value.to_vec(),
        version,
    }
}

/// The whole prefix `a/`: `0` is the byte after `/`.
fn all(limit: u32, reverse: bool, keys_only: bool) -> RangeRequest {
    RangeRequest {
        start: b"a/".to_vec(),
        end: b"a0".to_vec(),
        limit,
        reverse,
        keys_only,
    }
}

/// A store holding keys with bytes on both sides of 0x80, and a key that is
/// a prefix of another, written in neither order.
async fn ordered_store() -> (TempDir, SqliteEngine) {
    let (dir, store) = open_temp();
    store
        .writer
        .commit(vec![
            put(b"a/\xff", b"4"),
            put(b"a/\x01", b"0"),
            put(b"a/\x80\x00", b"3"),
            put(b"a/\x7f", b"1"),
            put(b"a/\x80", b"2"),
        ])
        .await
        .expect("the puts");
    (dir, store)
}

fn ordered() -> Vec<RangeResponse> {
    vec![
        entry(b"a/\x01", b"0", 1.0),
        entry(b"a/\x7f", b"1", 1.0),
        entry(b"a/\x80", b"2", 1.0),
        entry(b"a/\x80\x00", b"3", 1.0),
        entry(b"a/\xff", b"4", 1.0),
    ]
}

fn ok<T>(items: Vec<Result<T, ContractError>>) -> Vec<T> {
    items
        .into_iter()
        .map(|item| item.expect("an item"))
        .collect()
}

#[tokio::test]
async fn get_answers_in_request_order_with_absent_and_empty_values() {
    let (_dir, store) = open_temp();
    store
        .writer
        .commit(vec![put(b"a/b", b"B"), put(b"a/e", b"")])
        .await
        .expect("the puts");

    let read = collect(
        store
            .readers
            .get(vec![b"a/e".to_vec(), b"a/zz".to_vec(), b"a/b".to_vec()]),
    )
    .await;
    store.close().await;

    assert_eq!(
        ok(read),
        vec![
            GetResponse {
                key: b"a/e".to_vec(),
                value: Some(Vec::new()),
                version: 1.0,
            },
            GetResponse {
                key: b"a/zz".to_vec(),
                value: None,
                version: 0.0,
            },
            GetResponse {
                key: b"a/b".to_vec(),
                value: Some(b"B".to_vec()),
                version: 1.0,
            },
        ]
    );
}

#[tokio::test]
async fn range_answers_in_bytewise_order() {
    let (_dir, store) = ordered_store().await;

    let read = collect(store.readers.range(all(1000, false, false))).await;
    store.close().await;

    assert_eq!(ok(read), ordered());
}

#[tokio::test]
async fn a_reverse_range_answers_in_reverse_bytewise_order() {
    let (_dir, store) = ordered_store().await;

    let read = collect(store.readers.range(all(1000, true, false))).await;
    store.close().await;

    let mut expected = ordered();
    expected.reverse();
    assert_eq!(ok(read), expected);
}

#[tokio::test]
async fn a_range_stops_after_its_limit() {
    let (_dir, store) = ordered_store().await;

    let forward = collect(store.readers.range(all(2, false, false))).await;
    let reverse = collect(store.readers.range(all(2, true, false))).await;
    store.close().await;

    assert_eq!(ok(forward), ordered()[..2].to_vec());
    assert_eq!(
        ok(reverse),
        vec![entry(b"a/\xff", b"4", 1.0), entry(b"a/\x80\x00", b"3", 1.0)]
    );
}

#[tokio::test]
async fn a_keys_only_range_answers_empty_values() {
    let (_dir, store) = ordered_store().await;

    let read = collect(store.readers.range(all(1000, false, true))).await;
    store.close().await;

    let expected: Vec<_> = ordered()
        .into_iter()
        .map(|entry| RangeResponse {
            value: Vec::new(),
            ..entry
        })
        .collect();
    assert_eq!(ok(read), expected);
}

#[tokio::test]
async fn a_commit_during_a_range_does_not_change_its_later_rows() {
    let (_dir, store) = open_temp();
    let keys: Vec<Vec<u8>> = (0..40).map(|n| format!("a/k{n:02}").into_bytes()).collect();
    store
        .writer
        .commit(keys.iter().map(|key| put(key, b"v")).collect())
        .await
        .expect("the puts");

    let mut rows = store.readers.range(all(1000, false, false)).into_inner();
    let first = rows.recv().await.expect("a first row");
    store
        .writer
        .commit(vec![
            Item::Delete(b"a/k30".to_vec()),
            put(b"a/k35", b"new"),
            put(b"a/k25x", b"new"),
        ])
        .await
        .expect("the commit during the range");
    let mut read = vec![first];
    while let Some(row) = rows.recv().await {
        read.push(row);
    }
    drop(rows);
    store.close().await;

    let expected: Vec<_> = keys.iter().map(|key| entry(key, b"v", 1.0)).collect();
    assert_eq!(ok(read), expected);
}

#[tokio::test]
async fn a_read_after_close_is_unavailable() {
    let (_dir, store) = open_temp();

    store.close().await;
    let get = collect(store.readers.get(vec![b"a/k".to_vec()])).await;
    let range = collect(store.readers.range(all(10, false, false))).await;

    assert_eq!(get.len(), 1);
    assert_eq!(get[0].as_ref().expect_err("an error").code, "unavailable");
    assert_eq!(range.len(), 1);
    assert_eq!(range[0].as_ref().expect_err("an error").code, "unavailable");
}
