//! File-compatible read-only adapter for a dedicated worker's user-selected File objects.
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = globalThis, js_name = azerothFileSize)]
    fn size(name: &str) -> Result<f64, JsValue>;
    #[wasm_bindgen(catch, js_namespace = globalThis, js_name = azerothFileRead)]
    fn read(name: &str, offset: f64, length: u32) -> Result<js_sys::Uint8Array, JsValue>;
}
fn error(e: JsValue) -> io::Error {
    io::Error::other(format!("local file: {e:?}"))
}
pub struct File {
    name: String,
    len: u64,
    pos: u64,
    cached_at: u64,
    cache: Vec<u8>,
}
pub struct Metadata(u64);
impl Metadata {
    pub fn len(&self) -> u64 {
        self.0
    }
}
impl File {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let name = path.as_ref().to_string_lossy().into_owned();
        let len = size(&name).map_err(error)?;
        if !len.is_finite() || !(0.0..=16_000_000_000.0).contains(&len) {
            return Err(io::Error::other("invalid archive size"));
        }
        Ok(Self {
            name,
            len: len as u64,
            pos: 0,
            cached_at: 0,
            cache: Vec::new(),
        })
    }
    pub fn metadata(&self) -> io::Result<Metadata> {
        Ok(Metadata(self.len))
    }
}
impl Read for File {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || buf.is_empty() {
            return Ok(0);
        }
        if self.pos < self.cached_at || self.pos >= self.cached_at + self.cache.len() as u64 {
            self.cached_at = self.pos;
            self.cache = read(&self.name, self.pos as f64, 256 * 1024)
                .map_err(error)?
                .to_vec();
        }
        let start = (self.pos - self.cached_at) as usize;
        let n = buf.len().min(self.cache.len().saturating_sub(start));
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "archive truncated",
            ));
        }
        buf[..n].copy_from_slice(&self.cache[start..start + n]);
        self.pos += n as u64;
        Ok(n)
    }
}
impl Seek for File {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(n) => self.pos.checked_add_signed(n),
            SeekFrom::End(n) => self.len.checked_add_signed(n),
        }
        .ok_or_else(|| io::Error::other("invalid seek"))?;
        Ok(self.pos)
    }
}
