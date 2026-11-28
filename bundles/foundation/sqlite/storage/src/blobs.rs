//! `storage/v2`'s `PutBlob`, `GetBlob` and `DeleteBlob` (spec "The storage
//! contract", "Blobs", and "The layout"): a blob is content-addressed under
//! the writing bundle's prefix, its key `("blob", hash)` with `hash` the
//! `sha256:<hex>` of its bytes, a [`BlobHeader`](crate::layout::BlobHeader)
//! holding its first [`CHUNK_BYTES`](crate::layout::CHUNK_BYTES) and the
//! rest in `("blob.chunk", hash, n)` records.

use std::ops::ControlFlow;

use doric_bundle::ContractError;
use doric_sqlite::{KvEngine, ReadTxn, WriteTxn, refusal};
use sha2::Sha256;

use crate::{
    layout::{self, BlobHeader, CHUNK_BYTES},
    v2::{BlobHead, GetBlobResponse, get_blob_response::Item},
};

/// The most bytes of one blob (32 MiB, A36).
pub const BLOB_BYTES: usize = 33_554_432;

/// Whether `hash` is a blob hash: `sha256:` followed by 64 lowercase hex
/// digits, the form `PutBlob` answers.
pub fn well_formed(hash: &str) -> bool {
    hash.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The bytes of one `PutBlob` call as they arrive, and their SHA-256.
#[derive(Default)]
pub struct Upload {
    /// The bytes so far, at most [`BLOB_BYTES`].
    bytes: Vec<u8>,
    /// The SHA-256 of [`Upload::bytes`] so far.
    sha256: Sha256,
}

impl Upload {
    /// An upload of no bytes; [`put`] stores it as the empty blob.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `chunk`, the next bytes of the blob.
    ///
    /// # Errors
    ///
    /// `limit_exceeded` (`details.limit` `"blob"`) once the bytes pass
    /// [`BLOB_BYTES`]; the upload is then not to be put.
    pub fn push(&mut self, chunk: Vec<u8>) -> Result<(), ContractError> {
        if self.bytes.len() + chunk.len() > BLOB_BYTES {
            return Err(refusal(
                "limit_exceeded",
                format!("A blob holds at most {BLOB_BYTES} bytes."),
                "limit",
                "blob".into(),
            ));
        }
        sha2::Digest::update(&mut self.sha256, &chunk);
        self.bytes.extend_from_slice(&chunk);
        Ok(())
    }
}

/// Stores `upload` as a blob of `bundle` in one write transaction: its header
/// and chunks, unless its header exists, which means the same bytes are
/// stored. Answers its hash,
/// `sha256:<hex>`.
///
/// # Errors
///
/// The errors of the write.
pub async fn put<E: KvEngine>(
    engine: &E,
    bundle: &str,
    upload: Upload,
) -> Result<String, ContractError> {
    let hash = format!(
        "sha256:{}",
        doric_sqlite::hex(&sha2::Digest::finalize(upload.sha256))
    );
    let (bundle, stored) = (bundle.to_owned(), hash.clone());
    let bytes = upload.bytes;
    engine
        .write(move |txn| write(txn, &bundle, &stored, &bytes))
        .await?;
    Ok(hash)
}

/// Writes the blob `bytes` of `bundle` under `hash` in `txn`, unless its
/// header exists.
fn write(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    hash: &str,
    bytes: &[u8],
) -> Result<(), ContractError> {
    let key = layout::blob(bundle, hash);
    if txn.get(&key)?.is_some() {
        return Ok(());
    }
    let (first, rest) = bytes.split_at(bytes.len().min(CHUNK_BYTES));
    let mut chunk_count = 0;
    for (n, chunk) in (1..).zip(rest.chunks(CHUNK_BYTES)) {
        txn.put(&layout::blob_chunk(bundle, hash, n), chunk)?;
        chunk_count = n;
    }
    let header = BlobHeader {
        size: u32::try_from(bytes.len()).expect("a blob holds at most 32 MiB"),
        chunk_count,
        chunk: first.to_vec(),
    };
    txn.put(&key, &prost::Message::encode_to_vec(&header))
}

/// Reads the blob `hash` of `bundle` in the read transaction `txn`: emits
/// `head { found }`, then, when found, its bytes as chunks of 1 to 1,048,576
/// bytes, none for the empty blob. A malformed or unknown hash, the empty
/// one included, is `head { found: false }` and nothing else. Stops when
/// `emit` breaks.
///
/// # Errors
///
/// The errors of the read, and `internal` for a stored record that does not
/// decode.
pub fn get(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    hash: &str,
    emit: &mut dyn FnMut(GetBlobResponse) -> ControlFlow<()>,
) -> Result<(), ContractError> {
    let header = if well_formed(hash) {
        txn.get(&layout::blob(bundle, hash))?
            .map(|(value, _)| decode_header(&value))
            .transpose()?
    } else {
        None
    };
    let head = GetBlobResponse {
        item: Some(Item::Head(BlobHead {
            found: header.is_some(),
        })),
    };
    let Some(header) = header else {
        let _ = emit(head);
        return Ok(());
    };
    if emit(head).is_break() {
        return Ok(());
    }
    let chunk = |bytes| GetBlobResponse {
        item: Some(Item::Chunk(bytes)),
    };
    if !header.chunk.is_empty() && emit(chunk(header.chunk)).is_break() {
        return Ok(());
    }
    for n in 1..=header.chunk_count {
        let Some((bytes, _)) = txn.get(&layout::blob_chunk(bundle, hash, n))? else {
            return Err(ContractError::new(
                "internal",
                format!("The chunk {n} of the blob \"{hash}\" is missing."),
            ));
        };
        if emit(chunk(bytes)).is_break() {
            return Ok(());
        }
    }
    Ok(())
}

/// Decodes the stored blob header `value`; `internal` when it does not.
fn decode_header(value: &[u8]) -> Result<BlobHeader, ContractError> {
    <BlobHeader as prost::Message>::decode(value).map_err(|error| {
        ContractError::new(
            "internal",
            format!("A stored blob header does not decode: {error}."),
        )
    })
}

/// Deletes the blob `hash` of `bundle`, its header and its chunks, in one
/// write transaction. A malformed or unknown hash is a no-op.
///
/// # Errors
///
/// The errors of the write.
pub async fn delete<E: KvEngine>(
    engine: &E,
    bundle: &str,
    hash: &str,
) -> Result<(), ContractError> {
    if !well_formed(hash) {
        return Ok(());
    }
    let (bundle, hash) = (bundle.to_owned(), hash.to_owned());
    engine
        .write(move |txn| {
            let chunks = layout::under(&bundle, &["blob.chunk", &hash]);
            txn.clear_range(&chunks.start, &chunks.end)?;
            txn.delete(&layout::blob(&bundle, &hash))
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
