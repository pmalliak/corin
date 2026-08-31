//! Device credential storage. The credential authenticates this machine to the
//! backend for as long as the device is not revoked, so it belongs in the OS
//! keystore (Windows Credential Manager, Keychain, Secret Service), never in a
//! file next to the binary.

use anyhow::{Context, Result};

const SERVICE: &str = "corin-agent";
const ACCOUNT: &str = "device-credential";

pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, credential: &str) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

pub struct KeyringStore {
    service: String,
    account: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self { service: SERVICE.to_owned(), account: ACCOUNT.to_owned() }
    }

    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &self.account).context("could not open the OS credential store")
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(credential) => Ok(Some(credential)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("could not read the stored device credential"),
        }
    }

    fn save(&self, credential: &str) -> Result<()> {
        self.entry()?
            .set_password(credential)
            .context("could not store the device credential")
    }

    fn clear(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("could not remove the device credential"),
        }
    }
}

/// Used by tests and by `--no-keyring` runs on machines without a usable keystore.
/// It forgets everything when the process exits, which is the point.
#[derive(Default)]
pub struct MemoryStore {
    credential: std::sync::Mutex<Option<String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryStore {
    fn load(&self) -> Result<Option<String>> {
        Ok(self.credential.lock().expect("credential lock poisoned").clone())
    }

    fn save(&self, credential: &str) -> Result<()> {
        *self.credential.lock().expect("credential lock poisoned") = Some(credential.to_owned());
        Ok(())
    }

    fn clear(&self) -> Result<()> {
        *self.credential.lock().expect("credential lock poisoned") = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_round_trips_a_credential() {
        let store = MemoryStore::new();
        assert_eq!(store.load().unwrap(), None);

        store.save("a".repeat(64).as_str()).unwrap();
        assert_eq!(store.load().unwrap(), Some("a".repeat(64)));

        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn clearing_an_empty_store_is_not_an_error() {
        let store = MemoryStore::new();
        store.clear().unwrap();
        store.clear().unwrap();
    }
}
