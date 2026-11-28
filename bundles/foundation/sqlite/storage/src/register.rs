//! `storage/v2.Register` (A81): a caller's descriptor set, checked before any
//! I/O ([`prepare`]), then applied under the generation rule
//! ([`Registrations::apply`]).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    ops::ControlFlow,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use doric_bundle::{Caller, ContractError};
use doric_sqlite::{KeyRange, KvEngine, ReadTxn, WriteTxn};
use prost_reflect::DescriptorPool;

use crate::{
    layout::{self, TypeDeclaration},
    schema,
};

mod backfill;

/// The most documents of a type that one rebuild of its indexes reads (A81,
/// RK27). It bounds every rebuild, one that only removes indexes included:
/// a type of exactly this many documents rebuilds; one more is
/// `limit_exceeded` (`details.limit` `"rebuild"`), raised before any
/// document is decoded. 100,000 is RK27's result (AC4.25): 200,000 documents
/// of 1 KiB took 9,876 ms on the release build, so the limit is the largest
/// multiple of 10,000 that fits in 5 s.
pub const REBUILD_DOCUMENTS: usize = 100_000;

/// One rebuild of a type's indexes by [`Registrations::apply`]: the type id,
/// the number of its documents the rebuild read, and the time it took.
///
/// Its [`Display`](fmt::Display) is the line `Register` logs at `info`:
/// `Rebuilt the indexes of <type_id>: <documents> documents in <ms> ms.`,
/// with `<ms>` the elapsed time in whole milliseconds, truncated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rebuilt {
    /// The rebuilt type's id, as declared.
    pub type_id: String,
    /// The documents of the type the rebuild read, at most
    /// [`REBUILD_DOCUMENTS`].
    pub documents: usize,
    /// The time the rebuild took, inside the write transaction.
    pub elapsed: Duration,
}

impl fmt::Display for Rebuilt {
    /// Writes `Rebuilt the indexes of <type_id>: <documents> documents in
    /// <ms> ms.`; fails only when `f` does.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Rebuilt the indexes of {}: {} documents in {} ms.",
            self.type_id,
            self.documents,
            self.elapsed.as_millis()
        )
    }
}

/// A descriptor set checked for its caller, ready to apply: the caller's
/// bundle id and generation, the set's bytes and their lowercase SHA-256 hex,
/// the pool [`prepare`] built from them, with which a rebuild decodes the
/// stored documents, and the types it declares, each [`TypeDeclaration`]'s
/// `schema` that hash.
#[derive(Debug, Clone)]
pub struct Registration {
    bundle: String,
    generation: u32,
    hash: String,
    set: Vec<u8>,
    pool: DescriptorPool,
    types: BTreeMap<String, TypeDeclaration>,
}

/// Checks `descriptor_set` for `caller` before any I/O: the caller `doric`
/// first, then [`schema::pool`](crate::schema::pool) and
/// [`schema::declarations`](crate::schema::declarations) with the caller's
/// bundle id as owner; hashes the bytes with SHA-256.
///
/// # Errors
///
/// `not_owner` ("storage/v2 has no prefix for the caller doric; it may call
/// only Import, Inspect and Check.") for the caller `doric`; otherwise the
/// errors of `pool` and `declarations`.
pub fn prepare(caller: &Caller, descriptor_set: Vec<u8>) -> Result<Registration, ContractError> {
    let bundle = crate::bundle(caller)?;
    let pool = schema::pool(&descriptor_set)?;
    let mut types = schema::declarations(&pool, bundle)?;
    let hash = doric_sqlite::hex(&<sha2::Sha256 as sha2::Digest>::digest(&descriptor_set));
    for declaration in types.values_mut() {
        declaration.schema.clone_from(&hash);
    }
    Ok(Registration {
        bundle: caller.bundle_id.clone(),
        generation: caller.generation,
        hash,
        set: descriptor_set,
        pool,
        types,
    })
}

/// Per bundle, the highest generation that registered since the engine
/// process started (A81); only a successful registration raises it. Clones
/// share one memory.
#[derive(Debug, Default, Clone)]
pub struct Registrations {
    highest: Arc<Mutex<HashMap<String, u32>>>,
}

impl Registrations {
    /// Applies `registration` to `engine` under its bundle's prefix.
    ///
    /// A generation below the bundle's highest: `Ok` and no I/O. Otherwise one
    /// read transaction compares the stored schema, current and declarations;
    /// when all match, `Ok` with no write. Otherwise one write transaction
    /// re-checks the generation, then writes `("schema", hash)` and
    /// `("schema.current")`, each absent declaration, and each declaration
    /// whose indexes are equal but whose `message_type` or `schema` differs.
    /// A declaration whose indexes differ only in order is rewritten, and
    /// nothing is rebuilt. For any other change of indexes it rewrites the
    /// declaration and, when the type has a `("doc", type, …)` key, rebuilds
    /// the type's index keys and headers in the same transaction (A81): each
    /// rebuilt header keeps its revision and `updated_at`. It then deletes
    /// every schema no declaration names and current does not point at, and
    /// raises the memory on commit. Declarations of types absent from the
    /// set stay.
    ///
    /// Answers one [`Rebuilt`] per rebuilt type, in type id order; empty
    /// when nothing was rebuilt, including every `Ok` with no write.
    ///
    /// # Errors
    ///
    /// The first error of a rebuild, in type id order, with the transaction
    /// rolled back, nothing written and the memory unchanged:
    /// `limit_exceeded` (`details.limit` `"rebuild"`) for a type of more than
    /// [`REBUILD_DOCUMENTS`] documents; `unique_conflict` (details `{type,
    /// index, ids}`, `ids` the key's holder then the other document, in id
    /// key order) for the first new or changed unique index, in declared
    /// order, on which two documents share a key; `invalid_input` from
    /// [`schema::json_form`] as it is, for a stored value that does not
    /// decode; the errors of [`schema::index_values`] and [`layout::index`];
    /// `internal` for a stored header that does not decode, a missing chunk,
    /// or a message the set does not declare. Otherwise the errors of
    /// [`KvEngine::read`] and [`KvEngine::write`], with the memory unchanged.
    pub async fn apply<E: KvEngine>(
        &self,
        engine: &E,
        registration: Registration,
    ) -> Result<Vec<Rebuilt>, ContractError> {
        if self.is_below(&registration) {
            return Ok(Vec::new());
        }
        let registration = Arc::new(registration);
        let stored = Arc::clone(&registration);
        if engine.read(move |txn| is_stored(txn, &stored)).await? {
            self.raise(&registration);
            return Ok(Vec::new());
        }
        let registrations = self.clone();
        let (rebuilt, _) = engine
            .write(move |txn| {
                if registrations.is_below(&registration) {
                    return Ok(Vec::new());
                }
                let rebuilt = write(txn, &registration)?;
                txn.on_commit(Box::new(move || registrations.raise(&registration)));
                Ok(rebuilt)
            })
            .await?;
        Ok(rebuilt)
    }

    /// Whether a higher generation of `registration`'s bundle registered.
    fn is_below(&self, registration: &Registration) -> bool {
        let highest = self.highest.lock().unwrap_or_else(PoisonError::into_inner);
        highest
            .get(&registration.bundle)
            .is_some_and(|&highest| highest > registration.generation)
    }

    /// Raises the bundle's highest generation to `registration`'s.
    fn raise(&self, registration: &Registration) {
        let mut highest = self.highest.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = highest.entry(registration.bundle.clone()).or_default();
        *entry = (*entry).max(registration.generation);
    }
}

/// Whether the store already holds `registration`: its schema, current
/// pointing at it, and each of its declarations, equal.
fn is_stored(txn: &mut dyn ReadTxn, registration: &Registration) -> Result<bool, ContractError> {
    let bundle = &registration.bundle;
    if txn
        .get(&layout::schema(bundle, &registration.hash))?
        .is_none()
    {
        return Ok(false);
    }
    let current = txn.get(&layout::current(bundle))?;
    if current.map(|(value, _)| value) != Some(registration.hash.clone().into_bytes()) {
        return Ok(false);
    }
    for (type_id, declaration) in &registration.types {
        if stored_declaration(txn, bundle, type_id)?.as_ref() != Some(declaration) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Writes `registration`: its schema and current, each new or changed
/// declaration, rebuilding the indexes of a type with documents whose
/// indexes change other than by order, then deletes the schemas nothing
/// points at; answers the rebuilds, in type id order.
///
/// # Errors
///
/// The errors of [`backfill::rebuild`]; the errors of the transaction.
fn write(
    txn: &mut dyn WriteTxn,
    registration: &Registration,
) -> Result<Vec<Rebuilt>, ContractError> {
    let bundle = &registration.bundle;
    txn.put(
        &layout::schema(bundle, &registration.hash),
        &registration.set,
    )?;
    txn.put(&layout::current(bundle), registration.hash.as_bytes())?;
    let mut rebuilt = Vec::new();
    for (type_id, declaration) in &registration.types {
        let stored = stored_declaration(txn, bundle, type_id)?;
        if stored.as_ref() == Some(declaration) {
            continue;
        }
        txn.put(
            &layout::declaration(bundle, type_id),
            &prost::Message::encode_to_vec(declaration),
        )?;
        if let Some(stored) = stored {
            let pool = &registration.pool;
            rebuilt.extend(backfill::rebuilt(
                txn,
                bundle,
                type_id,
                pool,
                &stored,
                declaration,
            )?);
        }
    }

    let mut named = BTreeSet::from([layout::schema(bundle, &registration.hash)]);
    let mut failure = None;
    txn.range(&layout::under(bundle, &["type"]), &mut |entry| {
        match <TypeDeclaration as prost::Message>::decode(entry.value) {
            Ok(declaration) => {
                named.insert(layout::schema(bundle, &declaration.schema));
                ControlFlow::Continue(())
            }
            Err(error) => {
                failure = Some(undecodable(&error));
                ControlFlow::Break(())
            }
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    let mut unnamed = Vec::new();
    let schemas = KeyRange {
        keys_only: true,
        ..layout::under(bundle, &["schema"])
    };
    txn.range(&schemas, &mut |entry| {
        if !named.contains(entry.key) {
            unnamed.push(entry.key.to_vec());
        }
        ControlFlow::Continue(())
    })?;
    for key in &unnamed {
        txn.delete(key)?;
    }
    Ok(rebuilt)
}

/// The stored declaration of `type_id` under `bundle`, if any.
pub(crate) fn stored_declaration(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    type_id: &str,
) -> Result<Option<TypeDeclaration>, ContractError> {
    txn.get(&layout::declaration(bundle, type_id))?
        .map(|(value, _)| {
            <TypeDeclaration as prost::Message>::decode(value.as_slice())
                .map_err(|error| undecodable(&error))
        })
        .transpose()
}

/// The `internal` error of a stored declaration that does not decode.
fn undecodable(error: &prost::DecodeError) -> ContractError {
    ContractError::new(
        "internal",
        format!("A stored type declaration does not decode: {error}."),
    )
}

#[cfg(test)]
mod tests;
