#![forbid(unsafe_code)]
//! The storage layer of the engine bundle `sqlite` (spec
//! `docs/designs/grpc-processes.md`, section 17, "The storage contract" and
//! "The layout"): the tuple encoding of every key ([`keys`]), the layout's
//! records ([`layout`]), a bundle's descriptors and the index values of a
//! protobuf value decoded with them ([`schema`]), `Register` ([`register`]),
//! `Commit` ([`commit`]), `Get` ([`documents`]) and `Query` ([`query`]).

use doric_bundle::{Caller, ContractError};

pub mod blobs;
pub mod commit;
pub mod documents;
pub mod health;
pub mod keys;
pub mod layout;
pub mod query;
pub mod register;
pub mod schema;
pub mod streams;
#[cfg(test)]
mod testing;
pub mod watch;

/// The generated messages of `doric.storage.v2`.
#[allow(clippy::all)]
pub mod v2 {
    include!(concat!(env!("OUT_DIR"), "/doric.storage.v2.rs"));
}

/// The bundle whose prefix a `storage/v2` call reaches: `caller.bundle_id`,
/// the id the router stamped, never a name from the request.
///
/// # Errors
///
/// `not_owner`, message `storage/v2 has no prefix for the caller doric; it may
/// call only Import, Inspect and Check.`, no details, for the caller `doric`
/// ([`doric_sqlite::DORIC`]).
pub fn bundle(caller: &Caller) -> Result<&str, ContractError> {
    if caller.bundle_id == doric_sqlite::DORIC {
        return Err(ContractError::new(
            "not_owner",
            "storage/v2 has no prefix for the caller doric; it may call only Import, Inspect and Check.",
        ));
    }
    Ok(&caller.bundle_id)
}
