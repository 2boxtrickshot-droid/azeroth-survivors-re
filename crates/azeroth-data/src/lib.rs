//! Original MPQ parser exposed to the browser's local-data worker.
use benilla_mpq::Archive;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct LocalArchive(Archive);
#[wasm_bindgen]
impl LocalArchive {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Result<LocalArchive, JsValue> {
        Archive::open(name)
            .map(Self)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
    pub fn contains(&self, name: &str) -> bool {
        self.0.contains(name)
    }
    pub fn deleted(&self, name: &str) -> bool {
        self.0.is_delete_marker(name)
    }
    pub fn read(&self, name: &str) -> Result<Vec<u8>, JsValue> {
        // Refuse unreasonable individual assets before allocating from untrusted headers.
        if self
            .0
            .file_size(name)
            .is_some_and(|n| n > 128 * 1024 * 1024)
        {
            return Err(JsValue::from_str("asset exceeds 128 MiB limit"));
        }
        self.0
            .read_file(name)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
