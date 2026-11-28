use std::{
    ops::ControlFlow,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use doric_bundle::ContractError;
use rusqlite::Connection;

use super::{testing::*, *};
use crate::{Entry, KeyRange, KvEngine, ReadTxn, kv::GetResponse, limits::Item};

fn put(key: &[u8], value: &[u8]) -> Item {
    Item::Put {
        key: key.to_vec(),
        value: value.to_vec(),
    }
}

#[test]
fn a_missing_directory_is_storage_path_missing_and_is_not_created() {
    let dir = TempDir::missing();

    let error = open(dir.path()).err().expect("the open fails");

    assert_eq!(error.code, "storage_path_missing");
    assert_eq!(
        detail_str(&error, "path").as_deref(),
        Some(dir.path().to_str().expect("a UTF-8 path"))
    );
    assert!(!dir.path().exists());
}

#[test]
fn a_file_of_user_version_2_is_storage_format_unsupported_and_untouched() {
    let dir = TempDir::new();
    let file = dir.path().join(FILE);
    {
        let connection = Connection::open(&file).expect("open a plain connection");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("set user_version");
    }
    let before = std::fs::read(&file).expect("read the file");

    let error = open(dir.path()).err().expect("the open fails");

    assert_eq!(error.code, "storage_format_unsupported");
    assert_eq!(detail_num(&error, "userVersion"), Some(2.0));
    assert_eq!(std::fs::read(&file).expect("read the file"), before);
    let connection = Connection::open(&file).expect("reopen a plain connection");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read user_version");
    drop(connection);
    assert_eq!(version, 2);
    assert!(!dir.path().join(format!("{FILE}-wal")).exists());
}

#[tokio::test]
async fn an_empty_directory_gets_a_wal_file_of_format_1() {
    let dir = TempDir::new();

    let store = open(dir.path()).expect("open the store");
    store.close().await;

    let file = dir.path().join(FILE);
    assert!(file.is_file());
    let connection = Connection::open(&file).expect("open a plain connection");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read user_version");
    let mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .expect("read journal_mode");
    assert_eq!(version, 1);
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn keys_and_the_next_position_survive_a_reopen() {
    let dir = TempDir::new();
    let store = open(dir.path()).expect("open the store");
    let first = store
        .writer
        .commit(vec![put(b"a/k", b"v")])
        .await
        .expect("commit");
    store.close().await;

    let store = open(dir.path()).expect("reopen the store");
    let read = collect(store.readers.get(vec![b"a/k".to_vec()])).await;
    let second = store
        .writer
        .commit(vec![put(b"a/l", b"w")])
        .await
        .expect("commit after the reopen");
    store.close().await;

    assert_eq!(first, 1.0);
    assert_eq!(
        read,
        vec![Ok(GetResponse {
            key: b"a/k".to_vec(),
            value: Some(b"v".to_vec()),
            version: 1.0,
        })]
    );
    assert_eq!(second, 2.0);
}

/// A key, its value and its version, as a range visits them.
type Visited = (Vec<u8>, Vec<u8>, f64);

/// The entries of `range` that `txn` visits, stopping after `take`.
fn entries(
    txn: &mut dyn ReadTxn,
    range: &KeyRange,
    take: usize,
) -> Result<Vec<Visited>, ContractError> {
    let mut visited = Vec::new();
    txn.range(range, &mut |entry: Entry<'_>| {
        visited.push((entry.key.to_vec(), entry.value.to_vec(), entry.version));
        if visited.len() >= take {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    Ok(visited)
}

fn keys_of(visited: &[Visited]) -> Vec<Vec<u8>> {
    visited.iter().map(|(key, _, _)| key.clone()).collect()
}

fn bytes(keys: &[&str]) -> Vec<Vec<u8>> {
    keys.iter().map(|key| key.as_bytes().to_vec()).collect()
}

fn range_of(start: &[u8], end: &[u8]) -> KeyRange {
    KeyRange {
        start: start.to_vec(),
        end: end.to_vec(),
        ..KeyRange::default()
    }
}

fn aborted() -> ContractError {
    ContractError::new("aborted", "The work gave up.")
}

#[tokio::test]
async fn a_write_answers_its_value_and_position_and_a_read_then_gets_the_put() {
    let (_dir, engine) = open_temp();

    let written = engine
        .write(|txn| {
            txn.put(b"a/x", b"v")?;
            Ok("put")
        })
        .await;
    let read = engine.read(|txn| txn.get(b"a/x")).await;

    assert_eq!(written, Ok(("put", 1.0)));
    assert_eq!(read, Ok(Some((b"v".to_vec(), 1.0))));
}

#[tokio::test]
async fn writes_and_commits_take_consecutive_positions_that_version_their_keys() {
    let (_dir, engine) = open_temp();

    let (inside_first, first) = engine
        .write(|txn| {
            txn.put(b"a/1", b"v")?;
            Ok(txn.position())
        })
        .await
        .expect("the first write");
    let (inside_second, second) = engine
        .write(|txn| {
            txn.put(b"a/2", b"v")?;
            Ok(txn.position())
        })
        .await
        .expect("the second write");
    let third = engine
        .commit(vec![put(b"a/3", b"v")])
        .await
        .expect("the commit");
    let versions = engine
        .read(|txn| {
            [&b"a/1"[..], b"a/2", b"a/3"]
                .into_iter()
                .map(|key| Ok(txn.get(key)?.map(|(_, version)| version)))
                .collect::<Result<Vec<_>, ContractError>>()
        })
        .await;

    assert_eq!((second, third), (first + 1.0, first + 2.0));
    assert_eq!((inside_first, inside_second), (first, second));
    assert_eq!(versions, Ok(vec![Some(first), Some(second), Some(third)]));
}

#[tokio::test]
async fn a_failed_write_rolls_back_drops_its_callbacks_and_keeps_the_position() {
    let (_dir, engine) = open_temp();
    let ran = Arc::new(AtomicBool::new(false));
    let ((), last) = engine
        .write(|txn| txn.put(b"a/before", b"v"))
        .await
        .expect("a write");

    let flag = Arc::clone(&ran);
    let failed = engine
        .write(move |txn| {
            txn.put(b"a/x", b"v")?;
            txn.on_commit(Box::new(move || flag.store(true, Ordering::SeqCst)));
            Err::<(), _>(aborted())
        })
        .await;
    let ((), next) = engine
        .write(|txn| txn.put(b"a/after", b"v"))
        .await
        .expect("the next write");
    let absent = engine.read(|txn| txn.get(b"a/x")).await;

    assert_eq!(failed, Err(aborted()));
    assert_eq!(absent, Ok(None));
    assert!(!ran.load(Ordering::SeqCst), "the callback ran");
    assert_eq!(next, last + 1.0);
}

#[tokio::test]
async fn the_callbacks_of_a_write_run_before_the_next_write_begins() {
    let (_dir, engine) = open_temp();
    let ran = Arc::new(AtomicBool::new(false));

    let flag = Arc::clone(&ran);
    engine
        .write(move |txn| {
            txn.put(b"a/x", b"v")?;
            txn.on_commit(Box::new(move || flag.store(true, Ordering::SeqCst)));
            Ok(())
        })
        .await
        .expect("the write");
    let flag = Arc::clone(&ran);
    let (seen, _) = engine
        .write(move |txn| {
            txn.put(b"a/y", b"v")?;
            Ok(flag.load(Ordering::SeqCst))
        })
        .await
        .expect("the next write");

    assert!(seen, "the callback had not run");
}

#[tokio::test]
async fn a_range_visits_key_order_or_reverse_order_keys_only_and_stops_on_break() {
    let (_dir, engine) = open_temp();
    engine
        .write(|txn| {
            for n in 1..=5 {
                txn.put(format!("a/{n}").as_bytes(), format!("v{n}").as_bytes())?;
            }
            Ok(())
        })
        .await
        .expect("the seed");
    let all = range_of(b"a/", b"a0");

    let (forward, reversed, keys_only, first_two) = engine
        .read(move |txn| {
            Ok((
                entries(txn, &all, usize::MAX)?,
                entries(
                    txn,
                    &KeyRange {
                        reverse: true,
                        ..all.clone()
                    },
                    usize::MAX,
                )?,
                entries(
                    txn,
                    &KeyRange {
                        keys_only: true,
                        ..all.clone()
                    },
                    usize::MAX,
                )?,
                entries(txn, &all, 2)?,
            ))
        })
        .await
        .expect("the read");

    let ordered = bytes(&["a/1", "a/2", "a/3", "a/4", "a/5"]);
    assert_eq!(keys_of(&forward), ordered);
    assert_eq!(
        forward
            .iter()
            .map(|(_, value, _)| value.clone())
            .collect::<Vec<_>>(),
        bytes(&["v1", "v2", "v3", "v4", "v5"])
    );
    assert_eq!(
        keys_of(&reversed),
        bytes(&["a/5", "a/4", "a/3", "a/2", "a/1"])
    );
    assert_eq!(keys_of(&keys_only), ordered);
    assert!(keys_only.iter().all(|(_, value, _)| value.is_empty()));
    assert_eq!(keys_of(&first_two), bytes(&["a/1", "a/2"]));
}

#[tokio::test]
async fn a_write_deletes_a_key_and_clears_a_range_and_keeps_the_rest() {
    let (_dir, engine) = open_temp();
    engine
        .write(|txn| {
            for key in ["a/1", "a/2", "a/3", "a/4", "a/5", "b/x"] {
                txn.put(key.as_bytes(), b"v")?;
            }
            Ok(())
        })
        .await
        .expect("the seed");

    engine
        .write(|txn| {
            txn.delete(b"a/1")?;
            txn.clear_range(b"a/2", b"a/4")
        })
        .await
        .expect("the write");
    let left = engine
        .read(|txn| entries(txn, &range_of(b"", &[0xff]), usize::MAX))
        .await
        .expect("the read");

    assert_eq!(keys_of(&left), bytes(&["a/4", "a/5", "b/x"]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_sees_one_snapshot_while_a_write_commits() {
    let (_dir, engine) = open_temp();
    let (first_get, first_got) = tokio::sync::oneshot::channel();
    let (write_done, write_finished) = std::sync::mpsc::channel::<()>();

    let read = engine.read(move |txn| {
        let before = txn.get(b"a/x")?;
        let _ = first_get.send(());
        write_finished
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| ContractError::new("internal", "The write did not finish."))?;
        Ok((before, txn.get(b"a/x")?))
    });
    let write = async {
        first_got.await.expect("the read's first get");
        let written = engine.write(|txn| txn.put(b"a/x", b"v")).await;
        let _ = write_done.send(());
        written
    };
    let (read, write) = tokio::join!(read, write);

    assert_eq!(write.map(|((), _)| ()), Ok(()));
    assert_eq!(read, Ok((None, None)));
}

#[tokio::test]
async fn a_write_tells_whether_another_engine_wrote_the_file_since_its_last_commit() {
    let dir = TempDir::new();
    let b = open(dir.path()).expect("open B");
    let a = open(dir.path()).expect("open A");
    let foreign = |key: &'static [u8]| {
        move |txn: &mut dyn crate::WriteTxn| -> Result<bool, ContractError> {
            txn.put(key, b"v")?;
            Ok(txn.foreign_write())
        }
    };

    let (a_first, _) = a.write(foreign(b"a/x")).await.expect("A writes");
    let (b_first, _) = b.write(foreign(b"b/x")).await.expect("B writes");
    let (b_second, _) = b.write(foreign(b"b/y")).await.expect("B writes again");
    a.close().await;
    b.close().await;

    assert!(!a_first, "A's first write saw a foreign write");
    assert!(b_first, "B's first write missed A's write");
    assert!(!b_second, "B's second write saw a foreign write");
}

#[tokio::test]
async fn after_close_a_read_and_a_write_are_unavailable() {
    let (_dir, engine) = open_temp();

    KvEngine::close(&engine).await;
    let read = engine.read(|txn| txn.get(b"a/x")).await;
    let write = engine.write(|txn| txn.put(b"a/x", b"v")).await;

    assert_eq!(read.expect_err("the read is refused").code, "unavailable");
    assert_eq!(write.expect_err("the write is refused").code, "unavailable");
}
