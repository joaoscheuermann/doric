//! S77a4b: [`WriteTxn::foreign_write`] across `storage.kv/v1` commits (E1):
//! a commit of [`SqliteEngine::commit`] on the writer changes neither the
//! answer nor what it compares against.

use doric_bundle::ContractError;

use super::{open, testing::TempDir};
use crate::{KvEngine, WriteTxn, limits::Item};

/// A write of `key` that answers [`WriteTxn::foreign_write`].
fn foreign(key: &'static [u8]) -> impl FnOnce(&mut dyn WriteTxn) -> Result<bool, ContractError> {
    move |txn| {
        txn.put(key, b"v")?;
        Ok(txn.foreign_write())
    }
}

#[tokio::test]
async fn a_kv_commit_after_a_foreign_write_leaves_it_visible_to_the_next_write() {
    let dir = TempDir::new();
    let a = open(dir.path()).expect("open A");
    let b = open(dir.path()).expect("open B");

    a.write(foreign(b"a/x")).await.expect("A writes");
    b.write(foreign(b"b/x")).await.expect("B writes");
    a.commit(vec![Item::Put {
        key: b"doric/k".to_vec(),
        value: b"v".to_vec(),
    }])
    .await
    .expect("A commits through storage.kv/v1");
    let (seen, _) = a.write(foreign(b"a/y")).await.expect("A writes again");
    a.close().await;
    b.close().await;

    assert!(seen, "A's write after its kv commit missed B's write");
}
