//! `storage/v2`'s `Health` (spec "The storage contract"): the blocks of the
//! filesystem of `DORIC_STORAGE_PATH`, measured with `statvfs`, in today's
//! shape of `StorageHealth`.

use std::path::Path;

use nix::sys::statvfs::statvfs;

use crate::v2::{StorageDisk, StorageHealth};

/// The health of the storage directory `dir`: when `statvfs` measures it,
/// `{ status: "ok", writable: true, disk: { blocks: f_blocks,
/// availableBlocks: f_bavail } }` and no reason; otherwise
/// `{ status: "unavailable", writable: false, reason:
/// "storage_unmeasurable" }` and no disk.
pub fn measure(dir: &Path) -> StorageHealth {
    match statvfs(dir) {
        Ok(stat) => StorageHealth {
            status: "ok".to_owned(),
            writable: true,
            reason: None,
            disk: Some(StorageDisk {
                // Block counts stay below 2^53, so each is exact as an f64.
                blocks: stat.blocks() as f64,
                available_blocks: stat.blocks_available() as f64,
            }),
        },
        Err(_) => StorageHealth {
            status: "unavailable".to_owned(),
            writable: false,
            reason: Some("storage_unmeasurable".to_owned()),
            disk: None,
        },
    }
}

#[cfg(test)]
mod tests;
