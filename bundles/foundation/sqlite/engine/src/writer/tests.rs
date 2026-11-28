use super::*;
use crate::{
    kv::GetResponse,
    store::{FILE, testing::*},
};

fn put(key: &[u8], value: &[u8]) -> Item {
    Item::Put {
        key: key.to_vec(),
        value: value.to_vec(),
    }
}

fn condition(key: &[u8], version: f64) -> Item {
    Item::Condition {
        key: key.to_vec(),
        version,
    }
}

fn present(key: &[u8], value: &[u8], version: f64) -> Result<GetResponse, ContractError> {
    Ok(GetResponse {
        key: key.to_vec(),
        value: Some(value.to_vec()),
        version,
    })
}

fn absent(key: &[u8]) -> Result<GetResponse, ContractError> {
    Ok(GetResponse {
        key: key.to_vec(),
        value: None,
        version: 0.0,
    })
}

#[tokio::test]
async fn positions_rise_by_one_and_each_version_is_its_position() {
    let (_dir, store) = open_temp();
    let mut positions = Vec::new();
    for key in [b"a/1", b"a/2", b"a/3"] {
        positions.push(store.writer.commit(vec![put(key, b"v")]).await);
    }

    let read = collect(
        store
            .readers
            .get(vec![b"a/1".to_vec(), b"a/2".to_vec(), b"a/3".to_vec()]),
    )
    .await;
    store.close().await;

    assert_eq!(positions, vec![Ok(1.0), Ok(2.0), Ok(3.0)]);
    assert_eq!(
        read,
        vec![
            present(b"a/1", b"v", 1.0),
            present(b"a/2", b"v", 2.0),
            present(b"a/3", b"v", 3.0),
        ]
    );
}

#[tokio::test]
async fn a_condition_reads_the_state_before_the_commit() {
    let (_dir, store) = open_temp();

    let first = store
        .writer
        .commit(vec![put(b"a/k", b"v"), condition(b"a/k", 0.0)])
        .await;
    let second = store
        .writer
        .commit(vec![Item::Delete(b"a/k".to_vec()), condition(b"a/k", 1.0)])
        .await;
    store.close().await;

    assert_eq!(first, Ok(1.0));
    assert_eq!(second, Ok(2.0));
}

#[tokio::test]
async fn a_failing_condition_writes_nothing_and_names_the_first_failing_key() {
    let (_dir, store) = open_temp();
    store
        .writer
        .commit(vec![put(b"a/x", b"old")])
        .await
        .expect("the first commit");

    let error = store
        .writer
        .commit(vec![
            condition(b"a/x", 1.0),
            condition(b"a/y", 7.0),
            condition(b"a/m", 5.0),
            put(b"a/x", b"new"),
            put(b"a/z", b"v"),
        ])
        .await
        .expect_err("a condition fails");
    let read = collect(store.readers.get(vec![b"a/x".to_vec(), b"a/z".to_vec()])).await;
    let next = store.writer.commit(vec![put(b"a/n", b"v")]).await;
    store.close().await;

    assert_eq!(error.code, "condition_failed");
    assert_eq!(detail_str(&error, "key").as_deref(), Some("612f79"));
    assert_eq!(read, vec![present(b"a/x", b"old", 1.0), absent(b"a/z")]);
    assert_eq!(next, Ok(2.0));
}

#[tokio::test]
async fn a_later_mutation_on_the_same_key_wins() {
    let (_dir, store) = open_temp();

    store
        .writer
        .commit(vec![
            put(b"a/p", b"1"),
            put(b"a/p", b"2"),
            put(b"a/d", b"1"),
            Item::Delete(b"a/d".to_vec()),
        ])
        .await
        .expect("the commit");
    let read = collect(store.readers.get(vec![b"a/p".to_vec(), b"a/d".to_vec()])).await;
    store.close().await;

    assert_eq!(read, vec![present(b"a/p", b"2", 1.0), absent(b"a/d")]);
}

#[tokio::test]
async fn a_clear_range_includes_its_start_and_excludes_its_end() {
    let (_dir, store) = open_temp();
    store
        .writer
        .commit(vec![
            put(b"a/a", b"v"),
            put(b"a/b", b"v"),
            put(b"a/c", b"v"),
            put(b"a/d", b"v"),
        ])
        .await
        .expect("the puts");

    store
        .writer
        .commit(vec![Item::ClearRange {
            start: b"a/b".to_vec(),
            end: b"a/d".to_vec(),
        }])
        .await
        .expect("the clear range");
    let read = collect(store.readers.get(vec![
        b"a/a".to_vec(),
        b"a/b".to_vec(),
        b"a/c".to_vec(),
        b"a/d".to_vec(),
    ]))
    .await;
    store.close().await;

    assert_eq!(
        read,
        vec![
            present(b"a/a", b"v", 1.0),
            absent(b"a/b"),
            absent(b"a/c"),
            present(b"a/d", b"v", 1.0),
        ]
    );
}

#[tokio::test]
async fn a_positioned_put_writes_under_its_prefix_and_the_big_endian_position() {
    let (_dir, store) = open_temp();
    store
        .writer
        .commit(vec![put(b"a/x", b"v")])
        .await
        .expect("the first commit");

    let position = store
        .writer
        .commit(vec![Item::PositionedPut {
            key_prefix: b"a/p/".to_vec(),
            value: b"w".to_vec(),
        }])
        .await;
    let key = b"a/p/\x00\x00\x00\x00\x00\x00\x00\x02".to_vec();
    let read = collect(store.readers.get(vec![key.clone()])).await;
    store.close().await;

    assert_eq!(position, Ok(2.0));
    assert_eq!(read, vec![present(&key, b"w", 2.0)]);
}

#[tokio::test]
async fn close_checkpoints_the_wal_and_a_later_commit_is_unavailable() {
    let (dir, store) = open_temp();
    store
        .writer
        .commit(vec![put(b"a/k", b"v")])
        .await
        .expect("a commit");

    store.writer.close().await;

    let wal = dir.path().join(format!("{FILE}-wal"));
    assert!(std::fs::metadata(&wal).map_or(true, |wal| wal.len() == 0));
    let error = store
        .writer
        .commit(vec![put(b"a/l", b"v")])
        .await
        .expect_err("the writer is closed");
    assert_eq!(error.code, "unavailable");
    store.close().await;
}
