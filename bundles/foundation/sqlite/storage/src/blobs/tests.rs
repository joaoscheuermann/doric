//! S78b: `PutBlob`, `GetBlob` and `DeleteBlob` below the handlers (R9): the
//! upload's limit, the hash, idempotent puts, the records of a blob over one
//! record, reads of malformed, unknown and empty hashes, and deletes.

use doric_sqlite::{KeyRange, SqliteEngine};
use prost::Message as _;
use sha2::{Digest as _, Sha256};

use super::*;
use crate::{
    layout::{self, BlobHeader, CHUNK_BYTES},
    testing::{detail_str, open_temp},
    v2::{BlobHead, get_blob_response::Item},
};

/// The hash of no bytes.
const EMPTY: &str = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// The most bytes of one `PutBlobRequest.chunk` and `GetBlobResponse.chunk`.
const PART_BYTES: usize = 1_048_576;

/// `sha256:` and the lowercase hex of the SHA-256 of `bytes`.
fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", doric_sqlite::hex(&Sha256::digest(bytes)))
}

/// `len` bytes of every value, in a pattern that is not periodic per record.
fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|index| (index * 31 % 251) as u8).collect()
}

/// An upload of `bytes` in parts of at most 1 MiB.
fn upload(bytes: &[u8]) -> Upload {
    let mut upload = Upload::new();
    for part in bytes.chunks(PART_BYTES) {
        upload.push(part.to_vec()).expect("the part fits");
    }
    upload
}

/// Puts `bytes` as a blob of `bundle`.
async fn put_bytes(engine: &SqliteEngine, bundle: &str, bytes: &[u8]) -> String {
    put(engine, &Headers::default(), bundle, upload(bytes))
        .await
        .expect("the put succeeds")
}

/// The items [`get`] emits for `hash` of `bundle`.
async fn items(engine: &SqliteEngine, bundle: &str, hash: &str) -> Vec<GetBlobResponse> {
    let (bundle, hash) = (bundle.to_owned(), hash.to_owned());
    engine
        .read(move |txn| {
            let mut found = Vec::new();
            get(txn, &bundle, &hash, &mut |response| {
                found.push(response);
                ControlFlow::Continue(())
            })?;
            Ok(found)
        })
        .await
        .expect("the read succeeds")
}

/// The head of `items`, then the chunks after it, each as its bytes.
fn split(items: Vec<GetBlobResponse>) -> (BlobHead, Vec<Vec<u8>>) {
    let mut items = items.into_iter().map(|item| item.item.expect("an item"));
    let Some(Item::Head(head)) = items.next() else {
        panic!("the first item is the head");
    };
    let chunks = items
        .map(|item| match item {
            Item::Chunk(bytes) => bytes,
            Item::Head(_) => panic!("one head only"),
        })
        .collect();
    (head, chunks)
}

fn head(found: bool) -> GetBlobResponse {
    GetBlobResponse {
        item: Some(Item::Head(BlobHead { found })),
    }
}

/// The keys and values of `range`, in key order.
async fn records(engine: &SqliteEngine, range: KeyRange) -> Vec<(Vec<u8>, Vec<u8>)> {
    engine
        .read(move |txn| {
            let mut found = Vec::new();
            txn.range(&range, &mut |entry| {
                found.push((entry.key.to_vec(), entry.value.to_vec()));
                ControlFlow::Continue(())
            })?;
            Ok(found)
        })
        .await
        .expect("the read succeeds")
}

/// Every blob record of `bundle`: headers, then chunks.
async fn blob_records(engine: &SqliteEngine, bundle: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut found = records(engine, layout::under(bundle, &["blob"])).await;
    found.extend(records(engine, layout::under(bundle, &["blob.chunk"])).await);
    found
}

// The hash's form.

#[test]
fn a_hash_is_sha256_and_64_lowercase_hex_digits() {
    assert!(well_formed(EMPTY));
    assert!(well_formed(&format!("sha256:{}", "0".repeat(64))));
    for malformed in [
        "",
        "md5:abc",
        "sha256:",
        &format!("sha256:{}", "0".repeat(63)),
        &format!("sha256:{}", "0".repeat(65)),
        &format!("sha256:{}", "A".repeat(64)),
        &format!("sha256:{}", "g".repeat(64)),
        &format!("SHA256:{}", "0".repeat(64)),
        &"0".repeat(64),
    ] {
        assert!(!well_formed(malformed), "{malformed}");
    }
}

// The upload's limit.

#[test]
fn an_upload_takes_32_mib_and_one_byte_more_is_limit_exceeded_blob() {
    assert_eq!(BLOB_BYTES, 33_554_432);
    let mut upload = Upload::new();
    for _ in 0..BLOB_BYTES / PART_BYTES {
        upload.push(vec![1; PART_BYTES]).expect("within 32 MiB");
    }

    let error = upload.push(vec![1]).expect_err("past 32 MiB");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(detail_str(&error, "limit").as_deref(), Some("blob"));
}

// Put.

#[tokio::test]
async fn a_put_answers_the_sha256_of_the_bytes() {
    let (_dir, engine) = open_temp();
    let value = b"hello, blob".to_vec();

    let hash = put_bytes(&engine, "a", &value).await;

    assert_eq!(hash, sha256(&value));
}

#[tokio::test]
async fn the_empty_blob_has_the_hash_of_no_bytes() {
    let (_dir, engine) = open_temp();

    let hash = put(&engine, &Headers::default(), "a", Upload::new())
        .await
        .expect("the put succeeds");

    assert_eq!(hash, EMPTY);
}

#[tokio::test]
async fn a_second_put_of_the_same_bytes_answers_the_same_hash_and_changes_no_record() {
    let (_dir, engine) = open_temp();
    let value = bytes(CHUNK_BYTES + 10);
    let hash = put_bytes(&engine, "a", &value).await;
    let stored = blob_records(&engine, "a").await;

    let again = put_bytes(&engine, "a", &value).await;

    assert_eq!(again, hash);
    assert_eq!(blob_records(&engine, "a").await, stored);
}

#[tokio::test]
async fn the_same_bytes_in_other_parts_are_the_same_blob() {
    let (_dir, engine) = open_temp();
    let value = bytes(512);
    let hash = put_bytes(&engine, "a", &value).await;
    let mut pieces = Upload::new();
    for piece in value.chunks(100) {
        pieces.push(piece.to_vec()).expect("the piece fits");
    }

    let again = put(&engine, &Headers::default(), "a", pieces)
        .await
        .expect("the put succeeds");

    assert_eq!(again, hash);
}

#[tokio::test]
async fn a_blob_over_one_record_is_a_header_and_numbered_chunks_under_its_bundle() {
    let (_dir, engine) = open_temp();
    let value = bytes(6 * PART_BYTES);

    let hash = put_bytes(&engine, "a", &value).await;

    let headers = records(&engine, layout::under("a", &["blob"])).await;
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[0].0, layout::blob("a", &hash));
    let header = BlobHeader::decode(headers[0].1.as_slice()).expect("a blob header");
    // 6 MiB is 6,291,456 bytes: the header's 983,040, then six records.
    assert_eq!(header.size, 6_291_456);
    assert_eq!(header.chunk_count, 6);
    assert_eq!(header.chunk, value[..CHUNK_BYTES]);
    let chunks = records(&engine, layout::under("a", &["blob.chunk", &hash])).await;
    let keys: Vec<_> = chunks.iter().map(|(key, _)| key.clone()).collect();
    assert_eq!(
        keys,
        (1..=6)
            .map(|n| layout::blob_chunk("a", &hash, n))
            .collect::<Vec<_>>()
    );
    let stored: Vec<u8> = std::iter::once(header.chunk)
        .chain(chunks.into_iter().map(|(_, value)| value))
        .flatten()
        .collect();
    assert_eq!(stored, value);
    assert!(
        records(&engine, layout::under("b", &["blob"]))
            .await
            .is_empty()
    );
}

// Get.

#[tokio::test]
async fn a_blob_of_6_mib_reads_back_whole_in_chunks_of_at_most_1_mib() {
    let (_dir, engine) = open_temp();
    let value = bytes(6 * PART_BYTES);
    let hash = put_bytes(&engine, "a", &value).await;

    let (found, chunks) = split(items(&engine, "a", &hash).await);

    assert_eq!(found, BlobHead { found: true });
    for chunk in &chunks {
        assert!(
            (1..=PART_BYTES).contains(&chunk.len()),
            "a chunk of {} bytes",
            chunk.len()
        );
    }
    assert_eq!(chunks.concat(), value);
}

#[tokio::test]
async fn every_byte_value_round_trips() {
    let (_dir, engine) = open_temp();
    let value: Vec<u8> = (0..512).map(|index| (index % 256) as u8).collect();
    let hash = put_bytes(&engine, "a", &value).await;

    let (found, chunks) = split(items(&engine, "a", &hash).await);

    assert_eq!(found, BlobHead { found: true });
    assert_eq!(chunks.concat(), value);
}

#[tokio::test]
async fn the_empty_blob_is_found_with_no_chunk() {
    let (_dir, engine) = open_temp();
    put(&engine, &Headers::default(), "a", Upload::new())
        .await
        .expect("the put succeeds");

    assert_eq!(items(&engine, "a", EMPTY).await, vec![head(true)]);
}

#[tokio::test]
async fn a_malformed_unknown_or_empty_hash_is_not_found_and_nothing_else() {
    let (_dir, engine) = open_temp();
    put_bytes(&engine, "a", b"stored").await;
    let unknown = format!("sha256:{}", "0".repeat(64));

    for hash in ["md5:abc", "", unknown.as_str(), EMPTY] {
        assert_eq!(items(&engine, "a", hash).await, vec![head(false)], "{hash}");
    }
}

#[tokio::test]
async fn a_blob_of_another_bundle_is_not_found() {
    let (_dir, engine) = open_temp();
    let hash = put_bytes(&engine, "a", b"a's").await;

    assert_eq!(items(&engine, "b", &hash).await, vec![head(false)]);
}

// Delete.

#[tokio::test]
async fn a_delete_removes_the_header_and_every_chunk_and_keeps_other_blobs() {
    let (_dir, engine) = open_temp();
    let gone = put_bytes(&engine, "a", &bytes(3 * PART_BYTES)).await;
    let kept = put_bytes(&engine, "a", b"kept").await;

    delete(&engine, &Headers::default(), "a", &gone)
        .await
        .expect("the delete succeeds");

    assert_eq!(items(&engine, "a", &gone).await, vec![head(false)]);
    assert!(
        records(&engine, layout::under("a", &["blob.chunk", &gone]))
            .await
            .is_empty()
    );
    let (found, chunks) = split(items(&engine, "a", &kept).await);
    assert_eq!(found, BlobHead { found: true });
    assert_eq!(chunks.concat(), b"kept");
}

#[tokio::test]
async fn a_delete_of_a_malformed_or_unknown_hash_is_a_no_op() {
    let (_dir, engine) = open_temp();
    put_bytes(&engine, "a", b"kept").await;
    let stored = blob_records(&engine, "a").await;
    let unknown = format!("sha256:{}", "0".repeat(64));

    for hash in ["md5:abc", "", unknown.as_str()] {
        let deleted = delete(&engine, &Headers::default(), "a", hash).await;
        assert_eq!(deleted, Ok(()), "{hash}");
    }

    assert_eq!(blob_records(&engine, "a").await, stored);
}

#[tokio::test]
async fn a_delete_of_another_bundle_leaves_the_blob() {
    let (_dir, engine) = open_temp();
    let hash = put_bytes(&engine, "a", b"a's").await;

    delete(&engine, &Headers::default(), "b", &hash)
        .await
        .expect("the delete succeeds");

    assert_eq!(items(&engine, "a", &hash).await[0], head(true));
}
